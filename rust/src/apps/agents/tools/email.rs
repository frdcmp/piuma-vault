//! `send_email` agent tool. Sends a plain-text email via the SMTP service.
//!
//! Guardrails (the owner opted to allow arbitrary recipients): every send is
//! BCC'd to the vault owner for visibility, logged to `db_email_log` for audit,
//! and capped per 24h. The recipient/subject/body come from model output, so a
//! `web_fetch`-then-email flow could be steered — the BCC + cap + audit are the
//! mitigations.

use serde_json::{json, Value};

use crate::db::db::DbPool;

// Max sends per user per rolling 24h, across all sources (chat + cron).
const DAILY_CAP: i64 = 25;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![(
        "send_email",
        "Send a plain-text email. Use for reports/summaries the user asked to receive by email. \
         If `to` is omitted it goes to the vault owner. The owner is always BCC'd.",
        json!({
            "type": "object",
            "properties": {
                "to": { "type": "string", "description": "recipient email; defaults to the vault owner" },
                "subject": { "type": "string" },
                "body": { "type": "string", "description": "plain-text body" }
            },
            "required": ["subject", "body"]
        }),
    )]
}

pub async fn send_email(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let subject = args.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim();
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
    if subject.is_empty() || body.trim().is_empty() {
        return Err("subject and body are required".to_string());
    }

    // The vault owner's address — used as the default recipient and the BCC.
    let owner: Option<String> = sqlx::query_scalar("SELECT email FROM db_users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    let to = args
        .get("to")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| owner.clone())
        .ok_or_else(|| "no recipient and no owner email on file".to_string())?;

    // Rate limit: refuse once the rolling-24h count hits the cap.
    let recent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_email_log WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if recent >= DAILY_CAP {
        return Err(format!(
            "daily email limit reached ({DAILY_CAP}/24h) — not sending"
        ));
    }

    crate::apps::email::service::send(&to, subject, body, owner.as_deref()).await?;

    let _ = sqlx::query(
        "INSERT INTO db_email_log (user_id, to_addr, subject, source) VALUES ($1, $2, $3, 'agent')",
    )
    .bind(user_id)
    .bind(&to)
    .bind(subject)
    .execute(pool)
    .await;

    Ok(json!({ "ok": true, "to": to, "subject": subject }))
}
