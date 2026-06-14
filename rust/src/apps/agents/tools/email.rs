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
    vec![
        (
            "send_email",
            "Send a plain-text email. Use for reports/summaries the user asked to receive by email. \
             If `to` is omitted it goes to the vault owner. The owner is always BCC'd. If the result \
             has `needs_configuration: true`, no sending account is set up — tell the user to add one \
             in Settings → Services → Email and enable sending.",
            json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "recipient email; defaults to the vault owner" },
                    "subject": { "type": "string" },
                    "body": { "type": "string", "description": "plain-text body" }
                },
                "required": ["subject", "body"]
            }),
        ),
        (
            "read_email",
            "Read the most recent emails from a configured mailbox (IMAP). Use to check the inbox, \
             summarize recent mail, or look for a specific message. If the result has \
             `needs_configuration: true`, no reading account is set up — tell the user to add one in \
             Settings → Services → Email and enable reading (IMAP).",
            json!({
                "type": "object",
                "properties": {
                    "account": { "type": "string", "description": "optional: which account to read (its email address or label); defaults to the first reading-enabled account" },
                    "mailbox": { "type": "string", "description": "mailbox/folder to read; defaults to INBOX" },
                    "limit": { "type": "integer", "description": "how many recent messages to fetch (1–25, default 10)" }
                }
            }),
        ),
    ]
}

/// Friendly "not configured" result the agent should relay to the user instead
/// of treating as a hard failure.
fn needs_config(what: &str, enable: &str) -> Value {
    json!({
        "ok": false,
        "needs_configuration": true,
        "message": format!(
            "No email account with {what} is configured. Ask the user to set one up in \
             Settings → Services → Email (add an account and enable {enable})."
        )
    })
}

pub async fn send_email(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let subject = args.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim();
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
    if subject.is_empty() || body.trim().is_empty() {
        return Err("subject and body are required".to_string());
    }

    // No sending account → tell the agent to ask the user to configure one.
    if crate::apps::email::service::default_sender(pool).await.is_err() {
        return Ok(needs_config("sending (SMTP)", "sending"));
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

    crate::apps::email::service::send(pool, &to, subject, body, owner.as_deref()).await?;

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

pub async fn read_email(pool: &DbPool, _user_id: &str, args: &Value) -> Result<Value, String> {
    use crate::apps::email::service;
    use crate::apps::shares::crypto;

    let requested = args.get("account").and_then(|v| v.as_str());
    let mailbox = args
        .get("mailbox")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("INBOX")
        .to_string();
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(10);

    let acct = match service::reader_account(pool, requested).await {
        Ok(a) => a,
        Err(e) if e == "NO_READER" => return Ok(needs_config("reading (IMAP)", "reading (IMAP)")),
        Err(e) => return Err(e),
    };

    let password = crypto::decrypt(pool, &acct.imap_password)
        .await
        .ok_or_else(|| "could not decrypt IMAP password".to_string())?;
    let user = if acct.imap_username.trim().is_empty() {
        acct.email_address.clone()
    } else {
        acct.imap_username.clone()
    };

    let messages = service::imap_list(
        acct.imap_host.clone(),
        acct.imap_port as u16,
        acct.imap_security.clone(),
        user,
        password,
        mailbox.clone(),
        limit,
    )
    .await?;

    Ok(json!({
        "ok": true,
        "account": acct.email_address,
        "mailbox": mailbox,
        "count": messages.len(),
        "messages": messages,
    }))
}
