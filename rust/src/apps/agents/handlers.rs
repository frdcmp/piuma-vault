//! HTTP handlers for the agents module: agent listing, provider/model catalog,
//! agent-config (profile + personas), and conversation CRUD. The streaming chat
//! turn lives in `chat.rs`.

use actix_web::{web, HttpResponse, Responder};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::models::*;
use super::registry;

fn db_err(e: sqlx::Error) -> HttpResponse {
    log::error!("agents db error: {e}");
    HttpResponse::InternalServerError().json(ApiError::new("database error"))
}

// ── Agents ───────────────────────────────────────────────────────────────────

pub async fn list_agents(_user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    let mut out: Vec<AgentInfo> = Vec::new();
    for def in registry::all() {
        let display_name: Option<String> =
            sqlx::query_scalar("SELECT display_name FROM db_agent_profiles WHERE agent = $1")
                .bind(def.kind)
                .fetch_optional(pool.get_ref())
                .await
                .ok()
                .flatten()
                .filter(|s: &String| !s.trim().is_empty());
        out.push(AgentInfo {
            kind: def.kind.to_string(),
            display_name: display_name.unwrap_or_else(|| def.display_name.to_string()),
            persona: def.persona.to_string(),
            tool_count: def.tools.len(),
        });
    }
    HttpResponse::Ok().json(out)
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
             supports_vision, context_window, config, is_default) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
    )
    .bind(provider_id)
    .bind(&b.model_id)
    .bind(&b.display_name)
    .bind(b.supports_thinking)
    .bind(b.supports_tools)
    .bind(b.supports_vision)
    .bind(b.context_window)
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
        "INSERT INTO db_agent_profiles (agent, display_name, instructions, user_context, memory, updated_at) \
         VALUES ($1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,''), COALESCE($5,''), NOW()) \
         ON CONFLICT (agent) DO UPDATE SET \
            display_name = COALESCE($2, db_agent_profiles.display_name), \
            instructions = COALESCE($3, db_agent_profiles.instructions), \
            user_context = COALESCE($4, db_agent_profiles.user_context), \
            memory = COALESCE($5, db_agent_profiles.memory), \
            updated_at = NOW() \
         RETURNING *",
    )
    .bind(&agent)
    .bind(&b.display_name)
    .bind(&b.instructions)
    .bind(&b.user_context)
    .bind(&b.memory)
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
}

pub async fn list_conversations(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<ListConvQuery>,
) -> impl Responder {
    let res = if let Some(agent) = &q.agent {
        sqlx::query_as::<_, ConversationRow>(
            "SELECT * FROM db_chat_conversations WHERE archived_at IS NULL AND agent = $1 \
             ORDER BY updated_at DESC",
        )
        .bind(agent)
        .fetch_all(pool.get_ref())
        .await
    } else {
        sqlx::query_as::<_, ConversationRow>(
            "SELECT * FROM db_chat_conversations WHERE archived_at IS NULL ORDER BY updated_at DESC",
        )
        .fetch_all(pool.get_ref())
        .await
    };
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
    // Native agents pin a model (explicit, else the global default — may be None
    // and resolved at chat time). Gateway agents (OpenClaw) own their own model.
    let model_id: Option<Uuid> = if def.agent_type == registry::AgentType::Gateway {
        None
    } else {
        match b.model_id {
            Some(m) => Some(m),
            None => sqlx::query_scalar("SELECT id FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
                .fetch_optional(pool.get_ref())
                .await
                .ok()
                .flatten(),
        }
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
