//! Streaming chat turn (SSE) with a multi-round tool loop. Resolves the
//! conversation's agent/identity/model, assembles the system prompt, persists
//! the user message, then loops: stream a DeepSeek round → if it emits
//! tool_calls, run them (under the user) and feed results back → repeat until
//! the model answers. The full turn (thinking / tool_use / tool_result / text
//! blocks) is persisted. DeepSeek-only for now.

use actix_web::{web, HttpResponse, Responder};
use bytes::Bytes;
use futures::channel::mpsc;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::calendar::events::CalendarEventBus;
use crate::apps::notes::events::{NoteAction, NotesEventBus};
use crate::apps::realtime::ResourceAction;
use crate::apps::tasks::events::TasksEventBus;
use crate::db::db::DbPool;

use super::control::TurnControl;
use super::models::{ApiError, ChatTurnReq, ConversationRow, ModelRow, ProviderRow};
use super::providers::deepseek;
use super::{identities, registry, tools};

const MAX_ROUNDS: usize = 12;

pub(super) fn blocks_to_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn frame(payload: Value) -> Bytes {
    Bytes::from(format!("data: {payload}\n\n"))
}

/// After a mutating tool succeeds, publish to the matching live-update bus so
/// connected clients (web + mobile) refresh immediately — exactly as the HTTP
/// handlers do. Read-only tools (and ones with no id) are ignored.
fn publish_tool_event(
    name: &str,
    result: &Value,
    notes_bus: &NotesEventBus,
    tasks_bus: &TasksEventBus,
    calendar_bus: &CalendarEventBus,
) {
    use ResourceAction::{Created, Deleted, Updated};
    let id = result
        .get("id")
        .or_else(|| result.get("recurrence_id"))
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok());
    let Some(id) = id else { return };
    match name {
        "create_note" => notes_bus.publish(NoteAction::Created, id),
        "update_note" | "append_to_note" => notes_bus.publish(NoteAction::Updated, id),
        "delete_note" => notes_bus.publish(NoteAction::Deleted, id),
        "create_task" | "create_recurring" => tasks_bus.publish(Created, id),
        "update_task" | "toggle_task" | "update_recurring" | "complete_occurrence" => {
            tasks_bus.publish(Updated, id)
        }
        "delete_task" | "delete_recurring" => tasks_bus.publish(Deleted, id),
        "create_event" => calendar_bus.publish(Created, id),
        "update_event" => calendar_bus.publish(Updated, id),
        "delete_event" => calendar_bus.publish(Deleted, id),
        _ => {}
    }
}

/// Build the "current time" system block. Prefers the client's local time
/// (RFC3339 with offset) + IANA timezone; falls back to server UTC so the agent
/// always has *some* clock. Without this the model guesses the date/timezone.
fn current_time_context(timezone: Option<&str>, client_now: Option<&str>) -> String {
    let tz = timezone.map(str::trim).filter(|s| !s.is_empty());
    let now = client_now.map(str::trim).filter(|s| !s.is_empty());
    let tail = "When you call tools, emit RFC3339 timestamps that include this UTC offset (e.g. 2026-06-05T15:00:00+02:00), and interpret relative dates like \"today\" or \"tomorrow 3pm\" in this timezone.";
    match (now, tz) {
        (Some(n), Some(z)) => format!(
            "# Current time\nThe user's current local date and time is {n} (timezone {z}). {tail}"
        ),
        (Some(n), None) => format!(
            "# Current time\nThe user's current local date and time is {n}. {tail}"
        ),
        (None, Some(z)) => format!(
            "# Current time\nThe current UTC time is {}. The user's timezone is {z} — convert relative dates into it and emit RFC3339 timestamps with the correct offset.",
            chrono::Utc::now().to_rfc3339()
        ),
        (None, None) => format!(
            "# Current time\nThe current UTC time is {}. Emit RFC3339 timestamps with an explicit offset (Z for UTC) when calling tools.",
            chrono::Utc::now().to_rfc3339()
        ),
    }
}

/// Build a context preamble from the user's attached notes (the "locked" chips).
async fn build_context(pool: &DbPool, user_id: &str, ids: &[Uuid]) -> String {
    if ids.is_empty() {
        return String::new();
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT title, COALESCE(folder, '/'), content FROM notes \
         WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(ids)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if rows.is_empty() {
        return String::new();
    }
    let mut s = String::from("The user attached these notes as context:\n\n");
    for (title, folder, content) in rows {
        s.push_str(&format!("## {title} ({folder})\n{content}\n\n"));
    }
    s
}

/// Prepend the context block to the latest (user) message sent to the model —
/// the persisted user message stays raw, so the transcript shows what was typed.
fn inject_context(messages: &mut [Value], context: &str) {
    if context.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut() {
        let orig = last.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
        last["content"] = json!(format!("{context}\n{orig}"));
    }
}

/// Removes a turn's control entry (cancel token + injection mailbox) when the
/// streaming task ends — on normal completion, early break, error, or panic.
struct TurnGuard {
    control: TurnControl,
    conv: Uuid,
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.control.end(self.conv);
    }
}

pub async fn chat(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<ChatTurnReq>,
    notes_bus: web::Data<NotesEventBus>,
    tasks_bus: web::Data<TasksEventBus>,
    calendar_bus: web::Data<CalendarEventBus>,
    control: web::Data<TurnControl>,
) -> impl Responder {
    let conv_id = path.into_inner();
    let req = body.into_inner();
    let msg = req.message;
    let context_ids = req.context_note_ids;
    let timezone = req.timezone;
    let client_now = req.client_now;
    let db = pool.get_ref();

    let conv = match sqlx::query_as::<_, ConversationRow>("SELECT * FROM db_chat_conversations WHERE id = $1")
        .bind(conv_id)
        .fetch_optional(db)
        .await
    {
        Ok(Some(c)) => c,
        Ok(None) => return HttpResponse::NotFound().json(ApiError::new("conversation not found")),
        Err(e) => {
            log::error!("chat: load conv: {e}");
            return HttpResponse::InternalServerError().json(ApiError::new("database error"));
        }
    };

    let model_row: Option<ModelRow> = match conv.model_id {
        Some(mid) => sqlx::query_as("SELECT * FROM db_llm_models WHERE id = $1")
            .bind(mid)
            .fetch_optional(db)
            .await
            .ok()
            .flatten(),
        None => sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(db)
            .await
            .ok()
            .flatten(),
    };
    let Some(model_row) = model_row else {
        return HttpResponse::BadRequest().json(ApiError::new("no model configured — add one in admin → Agents"));
    };

    let provider: ProviderRow = match sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model_row.provider_id)
        .fetch_optional(db)
        .await
    {
        Ok(Some(p)) => p,
        _ => return HttpResponse::BadRequest().json(ApiError::new("provider not found")),
    };
    if provider.kind != "deepseek" {
        return HttpResponse::BadRequest().json(ApiError::new("only the deepseek provider is supported for now"));
    }
    if provider.api_key.trim().is_empty() {
        return HttpResponse::BadRequest().json(ApiError::new("provider has no API key set"));
    }

    let resolved = match identities::resolve(db, &conv.agent, &conv.identity).await {
        Ok(r) => r,
        Err(e) => return HttpResponse::BadRequest().json(ApiError::new(e)),
    };

    // Enabled tools = agent subscription ∩ persona.allowed_tools (None = all);
    // schemas_for further narrows to the tools actually implemented.
    let enabled: Vec<String> = match registry::get(&conv.agent) {
        Some(def) => {
            let allowed = resolved.persona.allowed_tools.clone();
            def.tools
                .iter()
                .map(|s| s.to_string())
                .filter(|t| allowed.as_ref().map_or(true, |a| a.contains(t)))
                .collect()
        }
        None => Vec::new(),
    };
    let tool_schemas = tools::schemas_for(&enabled);

    // Persist user message + set a title on the first turn.
    // Pre-embed the user message so L2 retrieval can use the cached vector
    // instead of calling the embedding API synchronously each turn.
    let user_content = json!([{ "type": "text", "text": msg }]);
    let user_text = blocks_to_text(&user_content);
    let user_emb = crate::apps::embeddings::embed(db, &user_text, 1536).await.ok();
    if let Err(e) = if let Some(ref emb) = user_emb {
        let pg_vec = pgvector::Vector::from(emb.clone());
        sqlx::query("INSERT INTO db_chat_messages (conversation_id, role, content, content_text, embedding) VALUES ($1, 'user', $2, $3, $4)")
            .bind(conv_id)
            .bind(&user_content)
            .bind(&user_text)
            .bind(&pg_vec)
            .execute(db)
            .await
    } else {
        sqlx::query("INSERT INTO db_chat_messages (conversation_id, role, content, content_text) VALUES ($1, 'user', $2, $3)")
            .bind(conv_id)
            .bind(&user_content)
            .bind(&user_text)
            .execute(db)
            .await
    } {
        log::error!("chat: persist user msg: {e}");
        return HttpResponse::InternalServerError().json(ApiError::new("database error"));
    }
    // First turn: set a cheap fallback title now; an AI title replaces it once
    // the exchange completes (see end of the stream task).
    let first_turn = conv.title.as_deref().unwrap_or("").is_empty();
    if first_turn {
        let title: String = msg.chars().take(60).collect();
        let _ = sqlx::query("UPDATE db_chat_conversations SET title = $2 WHERE id = $1")
            .bind(conv_id)
            .bind(&title)
            .execute(db)
            .await;
    }

    // Build OpenAI-shaped messages: system + capped history.
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT role, content FROM db_chat_messages WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(conv_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    let mut hist: Vec<(String, String)> = rows
        .into_iter()
        .filter(|(role, _)| role == "user" || role == "assistant")
        .map(|(role, content)| (role, blocks_to_text(&content)))
        .filter(|(_, text)| !text.trim().is_empty())
        .collect();
    if hist.len() > 50 {
        hist.drain(..hist.len() - 50);
    }
    let mut messages: Vec<Value> = Vec::with_capacity(hist.len() + 1);
    // Prepend a dynamic "current time" block so the agent can resolve relative
    // dates and emit correctly-offset timestamps (it otherwise has no clock).
    let now_block = current_time_context(timezone.as_deref(), client_now.as_deref());
    // Tell the agent its live runtime model. Without this it has no idea which
    // model it is and (wrongly) infers it from notes/plans, which go stale when
    // the conversation's model is changed.
    let model_block = format!(
        "# Your model\nYou are running on \"{}\" (provider: {}, API model id: {}). \
         This is the authoritative model for THIS conversation right now. When asked which \
         model or LLM you are, answer with this directly — do NOT look it up in notes, plans, \
         or documents, which may be out of date.",
        model_row.display_name, provider.kind, model_row.model_id,
    );
    // Teach every agent the in-app link convention so it can hand the user
    // clickable links straight to the entity it's talking about. Ids MUST come
    // from tool results (never invented); the client validates and degrades a
    // stale id to a toast rather than a broken view.
    let link_block = String::from(
        "# Linking & navigation\n\n\
         When you reference a specific note, calendar event, or task that you got from a tool, \
         link it with its real id using these in-app paths so the user can click straight to it:\n\
         - Note: `[title](/notes/<id>)`\n\
         - Calendar event: `[title](/admin/calendar?event=<id>)`\n\
         - Task: `[title](/tasks?task=<id>)`\n\
         - A whole view: `/notes`, `/tasks`, `/admin/calendar`, `/storage`\n\
         Only ever use ids returned by your tools — never guess one. External web pages: use a \
         normal `https://` markdown link.\n\n\
         To actively TAKE the user somewhere (not just offer a link), call the `navigate` tool — \
         it surfaces a one-click \"Go\" button. Prefer inline links for passing mentions; use \
         `navigate` when the user asked to be taken/shown/opened somewhere.",
    );
    let mut blocks = vec![now_block, model_block, link_block];
    if !resolved.system_prompt.trim().is_empty() {
        blocks.push(resolved.system_prompt.clone());
    }
    // L2: retrieve relevant long-term memories for this message and inject them as
    // a system block (best-effort; empty when nothing clears the distance floor).
    // Uses the precomputed user-message embedding when available to skip a
    // synchronous embed call.
    let retrieved = tools::memory::retrieve_for_turn(db, &conv.agent, user_emb.as_ref(), &msg, 5).await;
    let mem_block = tools::memory::format_block(&retrieved);
    if !mem_block.trim().is_empty() {
        blocks.push(mem_block);
    }
    // Opportunistic ask: surface 1-2 most-relevant pending facts for the agent
    // to casually verify with the user.
    let pending: Vec<_> = retrieved.iter().filter(|r| r.status == "pending").collect();
    if !pending.is_empty() {
        let mut pending_block = String::from(
            "# Pending facts (unconfirmed — verify with the user)\n\n\
             These are derived hypotheses that seemed relevant to this turn. When one comes up \
             naturally in conversation, casually ask the user if it's accurate (e.g. \"I've had \
             the impression you prefer X — is that right?\"). Use `memory_confirm` if they agree, \
             `memory_reject` if they disagree.\n",
        );
        for p in pending.iter().take(2) {
            pending_block.push_str(&format!("- [derived, unconfirmed] {}\n", p.content));
        }
        blocks.push(pending_block);
    }
    // Phase 0 observability: snapshot what was retrieved + L1 usage for the turn log.
    // L1 "always-in-context" usage spans BOTH injected fields — the agent's
    // `memory` scratchpad (cap 2200) and `user_context` (cap 1375) — measured
    // against their combined cap. (Counting `memory` alone read a false 0% since
    // the agent rarely writes to its scratchpad.)
    let retrieved_json = serde_json::to_value(&retrieved).unwrap_or_else(|_| json!([]));
    let l1_chars = (resolved.profile.memory.chars().count()
        + resolved.profile.user_context.chars().count()) as i32;
    let l1_pct = (l1_chars * 100 / (2200 + 1375)).min(100);
    let system = blocks.join("\n\n");
    if !system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for (role, text) in hist {
        messages.push(json!({ "role": role, "content": text }));
    }
    let context = build_context(db, &user.user_id, &context_ids).await;
    inject_context(&mut messages, &context);

    // ── Stream + tool loop ──
    let (tx, rx) = mpsc::unbounded::<Result<Bytes, actix_web::Error>>();
    let pool2 = db.clone();
    let user_id = user.user_id.clone();
    let agent_kind = conv.agent.clone();
    // Register this turn's cancel token *before* spawning so a STOP that arrives
    // the instant streaming begins finds it. `control` is cloned into the task
    // for draining injections and tearing the turn down on exit.
    let cancel = control.begin(conv_id);
    let control = control.get_ref().clone();
    // Live-update buses (cloned into the spawned task) so agent mutations push
    // to connected clients just like the HTTP handlers do.
    let notes_bus = notes_bus.get_ref().clone();
    let tasks_bus = tasks_bus.get_ref().clone();
    let calendar_bus = calendar_bus.get_ref().clone();
    let model_label = model_row.model_id.clone();
    let provider_kind = provider.kind.clone();
    let api_key = provider.api_key.clone();
    let base_url = provider.base_url.clone();
    let model = model_row.model_id.clone();

    actix_web::rt::spawn(async move {
        // Drop guard: clears this turn's cancel token + injection mailbox however
        // the task exits (completion, break, error, panic).
        let _guard = TurnGuard { control: control.clone(), conv: conv_id };

        // Heartbeat: emit an SSE comment every 15s so the stream never sits idle
        // during a slow tool round or while a reasoning model thinks before its
        // first token. Without it, Cloudflare/HTTP-2/the mobile radio reset the
        // idle stream ("stream was reset" / "connection abort"). Mirrors the
        // notes-events bus. Aborted when the turn ends (and stops itself if the
        // client has disconnected).
        let hb_tx = tx.clone();
        let heartbeat = actix_web::rt::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(15));
            ticker.tick().await; // consume the immediate first tick
            loop {
                ticker.tick().await;
                if hb_tx
                    .unbounded_send(Ok(Bytes::from_static(b": ping\n\n")))
                    .is_err()
                {
                    break;
                }
            }
        });

        let mut display: Vec<Value> = Vec::new();
        let mut tin = 0;
        let mut tout = 0;
        let mut stop = "end_turn".to_string();
        let mut errored = false;
        let mut answered = false;
        // Set when STOP cancels the turn mid-stream. We persist what we have and
        // mark the stop reason "cancelled".
        let mut stopped = false;

        'rounds: for _round in 0..MAX_ROUNDS {
            // INJECT: fold any messages queued mid-turn into the next round before
            // the model is called, so it sees them immediately.
            for inj in control.drain(conv_id) {
                let _ = tx.unbounded_send(Ok(frame(json!({ "type": "injected", "text": inj }))));
                // Record the injection inline in the turn's content so reloads place
                // it where it landed (interleaved), not hoisted above the whole reply.
                display.push(json!({ "type": "injected", "text": inj }));
                messages.push(json!({ "role": "user", "content": inj }));
            }

            // STOP: race the streaming round against the cancel signal. Dropping
            // the call future closes the in-flight provider socket immediately.
            let round = tokio::select! {
                biased;
                _ = cancel.cancelled() => { stopped = true; break 'rounds; }
                r = deepseek::call(&api_key, base_url.as_deref(), &model, &messages, &tool_schemas, &tx) => r,
            };
            match round {
                Ok(res) => {
                    tin += res.tokens_in;
                    tout += res.tokens_out;
                    stop = res.finish.clone();
                    if !res.thinking.trim().is_empty() {
                        display.push(json!({ "type": "thinking", "text": res.thinking }));
                    }
                    if res.tool_calls.is_empty() {
                        if !res.text.trim().is_empty() {
                            display.push(json!({ "type": "text", "text": res.text }));
                        }
                        answered = true;
                        break;
                    }
                    // Assistant turn that requested tools.
                    let tcs: Vec<Value> = res
                        .tool_calls
                        .iter()
                        .map(|t| json!({ "id": t.id, "type": "function", "function": { "name": t.name, "arguments": t.arguments } }))
                        .collect();
                    messages.push(json!({
                        "role": "assistant",
                        "content": if res.text.is_empty() { Value::Null } else { Value::String(res.text.clone()) },
                        "tool_calls": tcs,
                    }));
                    if !res.text.trim().is_empty() {
                        display.push(json!({ "type": "text", "text": res.text }));
                    }
                    for tc in &res.tool_calls {
                        // STOP: don't start a new tool once cancelled.
                        if cancel.is_cancelled() {
                            stopped = true;
                            break 'rounds;
                        }
                        let args: Value = serde_json::from_str(&tc.arguments).unwrap_or_else(|_| json!({}));
                        // Announce the tool (with its args) so the client can show it
                        // live, then signal completion once it has run.
                        let _ = tx.unbounded_send(Ok(frame(
                            json!({ "type": "tool", "id": tc.id, "name": tc.name, "args": args.clone() }),
                        )));
                        display.push(json!({ "type": "tool_use", "name": tc.name, "input": args.clone() }));
                        // STOP: a long-running tool can be cancelled too.
                        let result = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => { stopped = true; break 'rounds; }
                            r = tools::dispatch(&pool2, &user_id, &agent_kind, &tc.name, &args) => match r {
                                Ok(v) => v,
                                Err(e) => json!({ "error": e }),
                            },
                        };
                        let ok = result.get("error").is_none();
                        if ok {
                            publish_tool_event(&tc.name, &result, &notes_bus, &tasks_bus, &calendar_bus);
                        }
                        let _ = tx.unbounded_send(Ok(frame(
                            json!({ "type": "tool", "id": tc.id, "done": true, "ok": ok }),
                        )));
                        display.push(json!({ "type": "tool_result", "name": tc.name, "output": result.clone() }));
                        let content_str = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
                        messages.push(json!({ "role": "tool", "tool_call_id": tc.id, "content": content_str }));
                    }
                }
                Err(e) => {
                    log::error!("chat: deepseek round failed: {e}");
                    let _ = tx.unbounded_send(Ok(frame(json!({ "type": "error", "error": e }))));
                    errored = true;
                    break;
                }
            }
        }

        // The loop ran out of rounds while the model still wanted tools. Make one
        // final turn with tools disabled so it must synthesise an answer from what
        // it has gathered — otherwise the turn ends on a tool_use with no reply.
        // Skipped if the turn was stopped.
        if !errored && !answered && !stopped {
            messages.push(json!({
                "role": "user",
                "content": "You've reached the tool-call limit for this turn. Answer now \
                            using the information you've already gathered — do not request \
                            more tools. If something is still unknown, say so briefly.",
            }));
            tokio::select! {
                biased;
                _ = cancel.cancelled() => { stopped = true; }
                r = deepseek::call(&api_key, base_url.as_deref(), &model, &messages, &[], &tx) => match r {
                    Ok(res) => {
                        tin += res.tokens_in;
                        tout += res.tokens_out;
                        stop = res.finish.clone();
                        if !res.thinking.trim().is_empty() {
                            display.push(json!({ "type": "thinking", "text": res.thinking }));
                        }
                        if !res.text.trim().is_empty() {
                            display.push(json!({ "type": "text", "text": res.text }));
                        }
                    }
                    Err(e) => {
                        log::error!("chat: deepseek final answer failed: {e}");
                        let _ = tx.unbounded_send(Ok(frame(json!({ "type": "error", "error": e }))));
                        errored = true;
                    }
                },
            }
        }

        // A stopped turn still persists what was gathered, tagged "cancelled".
        if stopped {
            stop = "cancelled".to_string();
        }

        if !errored {
            let content = Value::Array(display);
            let msg_id: Option<Uuid> = sqlx::query_scalar(
                "INSERT INTO db_chat_messages \
                   (conversation_id, role, content, content_text, model_used, provider_kind, tokens_input, tokens_output, stop_reason) \
                 VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8) RETURNING id",
            )
            .bind(conv_id)
            .bind(&content)
            .bind(blocks_to_text(&content))
            .bind(&model_label)
            .bind(&provider_kind)
            .bind(tin)
            .bind(tout)
            .bind(&stop)
            .fetch_optional(&pool2)
            .await
            .ok()
            .flatten();
            let _ = sqlx::query("UPDATE db_chat_conversations SET updated_at = NOW() WHERE id = $1")
                .bind(conv_id)
                .execute(&pool2)
                .await;
            // Phase 0: log what the agent "knew" this turn (L2 retrieval + L1 usage).
            let _ = sqlx::query(
                "INSERT INTO db_agent_turn_logs \
                   (conversation_id, message_id, agent, retrieved, l1_memory_chars, l1_memory_pct) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(conv_id)
            .bind(msg_id)
            .bind(&agent_kind)
            .bind(&retrieved_json)
            .bind(l1_chars)
            .bind(l1_pct)
            .execute(&pool2)
            .await;
            // L4: fire-and-forget dialectic pass (runs only on the cadence
            // boundary). Spawned so it never delays the client after `done`.
            if !stopped {
                let dpool = pool2.clone();
                let dagent = agent_kind.clone();
                actix_web::rt::spawn(async move {
                    super::dialectic::maybe_run(&dpool, conv_id, dagent).await;
                });
            }
            let _ = tx.unbounded_send(Ok(frame(json!({
                "type": "done",
                "stop_reason": stop,
                "message_id": msg_id,
                "tokens_input": tin,
                "tokens_output": tout,
            }))));

            // Replace the fallback title with an AI-generated subject line now
            // that the first exchange exists. Best-effort, after `done`. Skipped
            // on a stopped turn — no point spending an LLM call on a cancelled one.
            if first_turn && !stopped {
                super::title::generate(&pool2, conv_id).await;
            }
        }

        // Turn is done — stop the heartbeat.
        heartbeat.abort();
    });

    HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(rx)
}

/// `POST /agents/conversations/{id}/stop` — STOP. Fires the conversation's cancel
/// token so the running turn halts mid-stream. Idempotent / safe if no turn is
/// active. Returns 202 with whether a turn was actually cancelled.
pub async fn stop(
    _user: AuthenticatedUser,
    path: web::Path<Uuid>,
    control: web::Data<TurnControl>,
) -> impl Responder {
    let cancelled = control.cancel(path.into_inner());
    HttpResponse::Accepted().json(json!({ "cancelled": cancelled }))
}

#[derive(serde::Deserialize)]
pub struct InjectReq {
    pub message: String,
}

/// `POST /agents/conversations/{id}/inject` — INJECT. Queues a user message into
/// the running turn, consumed at the next round boundary. The running turn
/// records it inline in its content blocks (an `injected` block) when it drains,
/// so it renders interleaved at the point it landed — no separate user row. Does
/// NOT open a stream. If no turn is active the client should POST `/chat` instead,
/// so this returns 409 `{ queued: false }` in that case.
pub async fn inject(
    _user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<InjectReq>,
    control: web::Data<TurnControl>,
) -> impl Responder {
    let conv_id = path.into_inner();
    let text = body.into_inner().message.trim().to_string();
    if text.is_empty() {
        return HttpResponse::BadRequest().json(ApiError::new("empty message"));
    }
    if !control.is_active(conv_id) {
        return HttpResponse::Conflict().json(json!({ "queued": false }));
    }
    control.inject(conv_id, text);
    HttpResponse::Accepted().json(json!({ "queued": true }))
}
