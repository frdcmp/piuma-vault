//! HTTP handlers for the agents module: agent listing, provider/model catalog,
//! agent-config (profile + personas), and conversation CRUD. The streaming chat
//! turn lives in `chat.rs`.

use actix_web::{web, HttpResponse, Responder};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::settings;
use crate::db::db::DbPool;

use super::models::*;
use super::registry;
use super::title;

const DEFAULT_AGENT_KEY: &str = "agents_default_agent";

fn fallback_agent() -> String {
    registry::all()
        .first()
        .map(|a| a.kind.to_string())
        .unwrap_or_else(|| "vault_agent".to_string())
}

fn db_err(e: sqlx::Error) -> HttpResponse {
    log::error!("agents db error: {e}");
    HttpResponse::InternalServerError().json(ApiError::new("database error"))
}

// ── Agents ───────────────────────────────────────────────────────────────────

pub async fn list_agents(_user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    let mut out: Vec<AgentInfo> = Vec::new();
    for def in registry::all() {
        let row: Option<(String, serde_json::Value)> =
            sqlx::query_as("SELECT display_name, commands FROM db_agent_profiles WHERE agent = $1")
                .bind(def.kind)
                .fetch_optional(pool.get_ref())
                .await
                .ok()
                .flatten();
        let (display_name, commands) = match row {
            Some((dn, cmds)) => (
                if dn.trim().is_empty() { def.display_name.to_string() } else { dn },
                cmds,
            ),
            None => (def.display_name.to_string(), json!([])),
        };
        out.push(AgentInfo {
            kind: def.kind.to_string(),
            display_name,
            persona: def.persona.to_string(),
            tool_count: def.tools.len(),
            commands,
        });
    }
    HttpResponse::Ok().json(out)
}

// ── Default agent (new conversations start with this) ───────────────────────

pub async fn get_default_agent(_user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    let stored = settings::store::get(pool.get_ref(), DEFAULT_AGENT_KEY).await;
    let agent = stored
        .filter(|s| registry::get(s).is_some())
        .unwrap_or_else(fallback_agent);
    HttpResponse::Ok().json(json!({ "agent": agent }))
}

pub async fn set_default_agent(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<DefaultAgentReq>,
) -> impl Responder {
    if registry::get(&body.agent).is_none() {
        return HttpResponse::BadRequest().json(ApiError::new("unknown agent"));
    }
    match settings::store::set(pool.get_ref(), DEFAULT_AGENT_KEY, &body.agent).await {
        Ok(_) => HttpResponse::Ok().json(json!({ "agent": body.agent })),
        Err(e) => db_err(e),
    }
}

// ── Providers ────────────────────────────────────────────────────────────────

pub async fn list_providers(_user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    match sqlx::query_as::<_, ProviderRow>("SELECT * FROM db_llm_providers ORDER BY display_name")
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(rows) => {
            let resp: Vec<ProviderResponse> = rows.into_iter().map(Into::into).collect();
            HttpResponse::Ok().json(resp)
        }
        Err(e) => db_err(e),
    }
}

pub async fn create_provider(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<CreateProviderReq>,
) -> impl Responder {
    let b = body.into_inner();
    match sqlx::query_as::<_, ProviderRow>(
        "INSERT INTO db_llm_providers (kind, display_name, api_key, base_url, config) \
         VALUES ($1, $2, $3, $4, $5) RETURNING *",
    )
    .bind(&b.kind)
    .bind(&b.display_name)
    .bind(&b.api_key)
    .bind(&b.base_url)
    .bind(&b.config)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(row) => HttpResponse::Ok().json(ProviderResponse::from(row)),
        Err(e) => db_err(e),
    }
}

pub async fn update_provider(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<UpdateProviderReq>,
) -> impl Responder {
    let id = path.into_inner();
    let b = body.into_inner();
    match sqlx::query_as::<_, ProviderRow>(
        "UPDATE db_llm_providers SET \
            display_name = COALESCE($2, display_name), \
            api_key = CASE WHEN $3 IS NOT NULL AND $3 <> '' THEN $3 ELSE api_key END, \
            base_url = COALESCE($4, base_url), \
            config = COALESCE($5, config), \
            enabled = COALESCE($6, enabled), \
            updated_at = NOW() \
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(&b.display_name)
    .bind(&b.api_key)
    .bind(&b.base_url)
    .bind(&b.config)
    .bind(b.enabled)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(ProviderResponse::from(row)),
        Ok(None) => HttpResponse::NotFound().json(ApiError::new("provider not found")),
        Err(e) => db_err(e),
    }
}

pub async fn delete_provider(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    match sqlx::query("DELETE FROM db_llm_providers WHERE id = $1")
        .bind(path.into_inner())
        .execute(pool.get_ref())
        .await
    {
        Ok(_) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(e) => db_err(e),
    }
}

// ── Models ───────────────────────────────────────────────────────────────────

pub async fn list_models(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    match sqlx::query_as::<_, ModelRow>(
        "SELECT * FROM db_llm_models WHERE provider_id = $1 ORDER BY display_name",
    )
    .bind(path.into_inner())
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(e) => db_err(e),
    }
}

/// Live model catalog from the provider's own API — powers the wire-id
/// suggestions in the admin UI. Best-effort: a bad key or unreachable provider
/// surfaces as a 502 with the upstream message.
pub async fn list_available_models(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    let provider: Option<ProviderRow> =
        match sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
            .bind(path.into_inner())
            .fetch_optional(pool.get_ref())
            .await
        {
            Ok(p) => p,
            Err(e) => return db_err(e),
        };
    let Some(provider) = provider else {
        return HttpResponse::NotFound().json(ApiError::new("provider not found"));
    };
    match super::providers::catalog::list_models(
        &provider.kind,
        &provider.api_key,
        provider.base_url.as_deref(),
    )
    .await
    {
        Ok(models) => HttpResponse::Ok().json(json!({ "models": models })),
        Err(e) => HttpResponse::BadGateway().json(ApiError::new(e)),
    }
}

/// All enabled models across providers — for the `/models` chat command picker.
pub async fn list_all_models(_user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    let rows: Vec<(Uuid, String, String, bool, String, f64, f64, f64)> = sqlx::query_as(
        "SELECT m.id, m.model_id, m.display_name, m.is_default, p.display_name, \
                m.price_input, m.price_output, m.price_cached \
         FROM db_llm_models m JOIN db_llm_providers p ON p.id = m.provider_id \
         WHERE m.enabled AND p.enabled ORDER BY p.display_name, m.display_name",
    )
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();
    let models: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, model_id, display_name, is_default, provider, price_input, price_output, price_cached)| {
            json!({ "id": id, "model_id": model_id, "display_name": display_name, "is_default": is_default, "provider": provider, "price_input": price_input, "price_output": price_output, "price_cached": price_cached })
        })
        .collect();
    HttpResponse::Ok().json(models)
}

pub async fn create_model(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<CreateModelReq>,
) -> impl Responder {
    let provider_id = path.into_inner();
    let b = body.into_inner();
    // Only one global default — clear others first if this one claims it.
    if b.is_default {
        if let Err(e) = sqlx::query("UPDATE db_llm_models SET is_default = FALSE WHERE is_default")
            .execute(pool.get_ref())
            .await
        {
            return db_err(e);
        }
    }
    match sqlx::query_as::<_, ModelRow>(
        "INSERT INTO db_llm_models \
            (provider_id, model_id, display_name, supports_thinking, supports_tools, \
             supports_vision, context_window, price_input, price_output, price_cached, config, is_default) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
    )
    .bind(provider_id)
    .bind(&b.model_id)
    .bind(&b.display_name)
    .bind(b.supports_thinking)
    .bind(b.supports_tools)
    .bind(b.supports_vision)
    .bind(b.context_window)
    .bind(b.price_input)
    .bind(b.price_output)
    .bind(b.price_cached)
    .bind(&b.config)
    .bind(b.is_default)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(row) => HttpResponse::Ok().json(row),
        Err(e) => db_err(e),
    }
}

pub async fn update_model(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<UpdateModelReq>,
) -> impl Responder {
    let id = path.into_inner();
    let b = body.into_inner();
    if b.is_default == Some(true) {
        if let Err(e) =
            sqlx::query("UPDATE db_llm_models SET is_default = FALSE WHERE is_default AND id <> $1")
                .bind(id)
                .execute(pool.get_ref())
                .await
        {
            return db_err(e);
        }
    }
    match sqlx::query_as::<_, ModelRow>(
        "UPDATE db_llm_models SET \
            display_name = COALESCE($2, display_name), \
            supports_thinking = COALESCE($3, supports_thinking), \
            supports_tools = COALESCE($4, supports_tools), \
            supports_vision = COALESCE($5, supports_vision), \
            context_window = COALESCE($6, context_window), \
            config = COALESCE($7, config), \
            is_default = COALESCE($8, is_default), \
            enabled = COALESCE($9, enabled), \
            price_input = COALESCE($10, price_input), \
            price_output = COALESCE($11, price_output), \
            price_cached = COALESCE($12, price_cached), \
            updated_at = NOW() \
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(&b.display_name)
    .bind(b.supports_thinking)
    .bind(b.supports_tools)
    .bind(b.supports_vision)
    .bind(b.context_window)
    .bind(&b.config)
    .bind(b.is_default)
    .bind(b.enabled)
    .bind(b.price_input)
    .bind(b.price_output)
    .bind(b.price_cached)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().json(ApiError::new("model not found")),
        Err(e) => db_err(e),
    }
}

pub async fn delete_model(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    match sqlx::query("DELETE FROM db_llm_models WHERE id = $1")
        .bind(path.into_inner())
        .execute(pool.get_ref())
        .await
    {
        Ok(_) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(e) => db_err(e),
    }
}

// ── Agent profile + personas ────────────────────────────────────────────────

pub async fn get_profile(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<String>,
) -> impl Responder {
    match sqlx::query_as::<_, AgentProfileRow>("SELECT * FROM db_agent_profiles WHERE agent = $1")
        .bind(path.into_inner())
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().json(ApiError::new("agent profile not found")),
        Err(e) => db_err(e),
    }
}

pub async fn patch_profile(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    body: web::Json<UpdateProfileReq>,
) -> impl Responder {
    let agent = path.into_inner();
    let b = body.into_inner();
    // Upsert — PATCH also seeds the row if it doesn't exist yet.
    match sqlx::query_as::<_, AgentProfileRow>(
        "INSERT INTO db_agent_profiles (agent, display_name, instructions, user_context, memory, commands, updated_at) \
         VALUES ($1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,''), COALESCE($5,''), COALESCE($6,'[]'::jsonb), NOW()) \
         ON CONFLICT (agent) DO UPDATE SET \
            display_name = COALESCE($2, db_agent_profiles.display_name), \
            instructions = COALESCE($3, db_agent_profiles.instructions), \
            user_context = COALESCE($4, db_agent_profiles.user_context), \
            memory = COALESCE($5, db_agent_profiles.memory), \
            commands = COALESCE($6, db_agent_profiles.commands), \
            updated_at = NOW() \
         RETURNING *",
    )
    .bind(&agent)
    .bind(&b.display_name)
    .bind(&b.instructions)
    .bind(&b.user_context)
    .bind(&b.memory)
    .bind(&b.commands)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(row) => HttpResponse::Ok().json(row),
        Err(e) => db_err(e),
    }
}

pub async fn list_personas(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<String>,
) -> impl Responder {
    match sqlx::query_as::<_, PersonaRow>(
        "SELECT * FROM db_agent_personas WHERE agent = $1 ORDER BY name",
    )
    .bind(path.into_inner())
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(e) => db_err(e),
    }
}

pub async fn patch_persona(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<UpdatePersonaReq>,
) -> impl Responder {
    let id = path.into_inner();
    let b = body.into_inner();
    match sqlx::query_as::<_, PersonaRow>(
        "UPDATE db_agent_personas SET \
            display_name = COALESCE($2, display_name), \
            emoji = COALESCE($3, emoji), \
            system_prompt = COALESCE($4, system_prompt), \
            allowed_tools = COALESCE($5, allowed_tools), \
            config = COALESCE($6, config), \
            updated_at = NOW() \
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(&b.display_name)
    .bind(&b.emoji)
    .bind(&b.system_prompt)
    .bind(&b.allowed_tools)
    .bind(&b.config)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().json(ApiError::new("persona not found")),
        Err(e) => db_err(e),
    }
}

// ── Conversations ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ListConvQuery {
    pub agent: Option<String>,
    /// Free-text filter: matches conversation title or any message's text.
    pub q: Option<String>,
}

pub async fn list_conversations(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<ListConvQuery>,
) -> impl Responder {
    // Optional filters: agent (exact) and free-text q (title or message text).
    // Both treat absent/blank as "no filter" via the `$n IS NULL` guards.
    let agent = q.agent.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let search = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let res = sqlx::query_as::<_, ConversationRow>(
        "SELECT * FROM db_chat_conversations c \
         WHERE c.archived_at IS NULL \
           AND ($1::text IS NULL OR c.agent = $1) \
           AND ($2::text IS NULL \
                OR c.title ILIKE '%' || $2 || '%' \
                OR EXISTS (SELECT 1 FROM db_chat_messages m \
                           WHERE m.conversation_id = c.id \
                             AND m.content::text ILIKE '%' || $2 || '%')) \
         ORDER BY c.updated_at DESC",
    )
    .bind(agent)
    .bind(search)
    .fetch_all(pool.get_ref())
    .await;
    match res {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(e) => db_err(e),
    }
}

pub async fn create_conversation(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<CreateConversationReq>,
) -> impl Responder {
    let b = body.into_inner();
    let Some(def) = registry::get(&b.agent) else {
        return HttpResponse::BadRequest().json(ApiError::new("unknown agent"));
    };
    // Pin a model: explicit, else the global default (may be None, resolved at
    // chat time).
    let model_id: Option<Uuid> = match b.model_id {
        Some(m) => Some(m),
        None => sqlx::query_scalar("SELECT id FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(pool.get_ref())
            .await
            .ok()
            .flatten(),
    };
    match sqlx::query_as::<_, ConversationRow>(
        "INSERT INTO db_chat_conversations (agent, title, model_id, identity) \
         VALUES ($1, $2, $3, $4) RETURNING *",
    )
    .bind(def.kind)
    .bind(&b.title)
    .bind(model_id)
    .bind(def.persona)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(row) => HttpResponse::Ok().json(row),
        Err(e) => db_err(e),
    }
}

pub async fn get_conversation(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    let id = path.into_inner();
    let conv = match sqlx::query_as::<_, ConversationRow>(
        "SELECT * FROM db_chat_conversations WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(Some(c)) => c,
        Ok(None) => return HttpResponse::NotFound().json(ApiError::new("conversation not found")),
        Err(e) => return db_err(e),
    };
    let messages = match sqlx::query_as::<_, MessageRow>(
        "SELECT * FROM db_chat_messages WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(id)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(m) => m,
        Err(e) => return db_err(e),
    };
    HttpResponse::Ok().json(json!({ "conversation": conv, "messages": messages }))
}

pub async fn update_conversation(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<UpdateConversationReq>,
) -> impl Responder {
    let id = path.into_inner();
    let b = body.into_inner();
    // archived: Some(true) → set NOW(), Some(false) → clear, None → leave.
    match sqlx::query_as::<_, ConversationRow>(
        "UPDATE db_chat_conversations SET \
            title = COALESCE($2, title), \
            model_id = COALESCE($3, model_id), \
            archived_at = CASE WHEN $4 IS NULL THEN archived_at \
                               WHEN $4 THEN NOW() ELSE NULL END, \
            updated_at = NOW() \
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(&b.title)
    .bind(b.model_id)
    .bind(b.archived)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().json(ApiError::new("conversation not found")),
        Err(e) => db_err(e),
    }
}

pub async fn delete_conversation(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    match sqlx::query("DELETE FROM db_chat_conversations WHERE id = $1")
        .bind(path.into_inner())
        .execute(pool.get_ref())
        .await
    {
        Ok(_) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(e) => db_err(e),
    }
}

/// Force an AI re-title of a conversation (the `/title → auto-rename` action).
/// Returns the new title, or 400 if there's nothing to summarize / no model.
pub async fn retitle_conversation(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    match title::regenerate(pool.get_ref(), path.into_inner()).await {
        Some(t) => HttpResponse::Ok().json(json!({ "title": t })),
        None => HttpResponse::BadRequest().json(ApiError::new(
            "could not generate a title (no messages yet, or no default model configured)",
        )),
    }
}

/// Clear a conversation in place: delete all its messages and reset the title
/// (and the `ai_titled` marker) so the next turn re-titles a fresh slate. The
/// conversation row and its id are preserved, so the thread keeps streaming to
/// the same session.
pub async fn clear_conversation(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    let id = path.into_inner();
    if let Err(e) = sqlx::query("DELETE FROM db_chat_messages WHERE conversation_id = $1")
        .bind(id)
        .execute(pool.get_ref())
        .await
    {
        return db_err(e);
    }
    match sqlx::query(
        "UPDATE db_chat_conversations \
         SET title = NULL, metadata = metadata - 'ai_titled', updated_at = NOW() \
         WHERE id = $1",
    )
    .bind(id)
    .execute(pool.get_ref())
    .await
    {
        Ok(r) if r.rows_affected() == 0 => {
            HttpResponse::NotFound().json(ApiError::new("conversation not found"))
        }
        Ok(_) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(e) => db_err(e),
    }
}
