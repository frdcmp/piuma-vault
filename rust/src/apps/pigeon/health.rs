//! Health: Pigeon tells the user when it can't do its job for them. The worker checks what it
//! depends on every two minutes, and a problem seen for a few minutes is posted (General, with
//! sound), again every 6 hours while it lasts, and "back" once it's gone:
//!
//!   - a connection in error (Gmail, Instagram, WhatsApp), or Gmail not synced for 20 minutes
//!   - WhatsApp not connected (logged out, phone offline)
//!   - an Instagram token about to expire
//!   - their conversations stuck waiting for triage
//!   - a part of the worker failing over and over (triage: `failed` / `ok` from it)
//!
//! Alerts are kept in `db_pigeon_health_alerts`, per user.

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};

use crate::apps::pigeon::state::State;
use crate::apps::pigeon::{cards, connectors, owner};

/// A problem is posted once it has lasted this long (a blip isn't).
const AFTER_MINUTES: i64 = 3;
/// Posted again while it lasts.
const REMIND_HOURS: i64 = 6;
/// Gmail is polled every minute or so: this long without a sync is a problem.
const GMAIL_STALE_MINUTES: i32 = 20;

/// The parts that report their own failures: since when, and the last error.
fn failures() -> &'static Mutex<HashMap<&'static str, (DateTime<Utc>, String)>> {
    static F: std::sync::OnceLock<Mutex<HashMap<&'static str, (DateTime<Utc>, String)>>> = std::sync::OnceLock::new();
    F.get_or_init(Default::default)
}

/// A part failed (it keeps failing since the first time, until `ok`).
pub fn failed(part: &'static str, error: impl Into<String>) {
    let mut f = failures().lock().unwrap_or_else(|e| e.into_inner());
    let error = error.into();
    f.entry(part).and_modify(|(_, e)| *e = error.clone()).or_insert((Utc::now(), error));
}

/// A part worked.
pub fn ok(part: &'static str) {
    failures().lock().unwrap_or_else(|e| e.into_inner()).remove(part);
}

fn clip(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max {
        s
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// What's wrong for the user now: a key each (the same problem keeps its key), and what to
/// tell them.
async fn problems(st: &State, user: &str) -> anyhow::Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    let me = owner::get(&st.pool, user).await;
    let local = |t: DateTime<Utc>| me.local(t).format("%-d %b %H:%M").to_string();
    // connections in error, Gmail not syncing
    let conns: Vec<(String, String, String, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
        "SELECT connector, account, status, last_ok_at, last_error FROM db_pigeon_connections WHERE user_id = $1 AND status <> 'disconnected'",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    for (connector, account, status, last_ok, error) in &conns {
        let title = connectors::find(st, connector).map(|c| c.title()).unwrap_or(connector);
        if status == "error" {
            out.push((format!("conn:{connector}:{account}"), format!("{title} {account} is failing: {}", clip(error.as_deref().unwrap_or("error"), 200))));
        } else if connector == "gmail" && last_ok.is_none_or(|t| t < Utc::now() - chrono::Duration::minutes(GMAIL_STALE_MINUTES as i64)) {
            let since = last_ok.map(|t| format!(" since {}", local(t))).unwrap_or_default();
            out.push((format!("stale:{connector}:{account}"), format!("Gmail {account} hasn't synced{since}")));
        }
    }
    // the WhatsApp bridge, when there's an account
    if conns.iter().any(|(c, ..)| c == "whatsapp") {
        if let Some(wa) = connectors::find(st, "whatsapp").filter(|c| c.available(st).is_ok()) {
            let h = wa.health(st, user).await;
            let state = h["server"]["state"].as_str().map(str::to_string).or_else(|| h["server"]["error"].as_str().map(|e| format!("unreachable ({})", clip(e, 120))));
            match state.as_deref() {
                Some("connected") => {}
                Some(s) => out.push(("whatsapp:bridge".into(), format!("WhatsApp is {s}: messages aren't reaching Pigeon. Connect it again in the Inbox's settings"))),
                None => out.push(("whatsapp:bridge".into(), "WhatsApp's bridge doesn't answer".into())),
            }
        }
    }
    // an Instagram token about to expire
    let expiring: Vec<(String, i64)> = sqlx::query_as(
        "SELECT account, (settings->>'token_expires_at')::bigint FROM db_pigeon_connections
          WHERE user_id = $1 AND connector = 'instagram' AND status = 'connected'
            AND (settings->>'token_expires_at')::bigint < EXTRACT(EPOCH FROM NOW() + INTERVAL '7 days')",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    for (account, at) in expiring {
        let when = DateTime::from_timestamp(at, 0).map(local).unwrap_or_default();
        out.push((format!("token:instagram:{account}"), format!("Instagram {account}'s access ends {when}: connect it again in the Inbox's settings")));
    }
    // triage stuck
    let stuck: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM db_pigeon_conversations WHERE user_id = $1 AND triage_due_at < NOW() - INTERVAL '10 minutes'")
        .bind(user)
        .fetch_one(&st.pool)
        .await?;
    if stuck > 0 {
        out.push(("triage:stuck".into(), format!("{stuck} conversation(s) waiting for triage for over 10 minutes")));
    }
    // parts failing over and over
    let failing: Vec<(&'static str, DateTime<Utc>, String)> =
        failures().lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, (since, e))| (*k, *since, e.clone())).collect();
    for (part, since, error) in failing {
        if Utc::now() - since >= chrono::Duration::minutes(AFTER_MINUTES) {
            out.push((format!("part:{part}"), format!("{part} has been failing since {}: {}", local(since), clip(&error, 200))));
        }
    }
    Ok(out)
}

/// What to say when a problem is gone, from its key.
fn fixed(key: &str) -> String {
    let mut parts = key.splitn(3, ':');
    let (kind, a, b) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    let title = |c: &str| match c {
        "gmail" => "Gmail",
        "instagram" => "Instagram",
        "whatsapp" => "WhatsApp",
        c => c,
    }
    .to_string();
    match kind {
        "conn" => format!("{} {b} works again", title(a)),
        "stale" => format!("{} {b} syncs again", title(a)),
        "whatsapp" => "WhatsApp is connected again".into(),
        "token" => format!("{} {b} is connected again", title(a)),
        "triage" => "Triage caught up".into(),
        "part" => format!("{a} works again"),
        _ => format!("{key}: fine again"),
    }
}

/// One check for the user: new problems seen long enough are posted, old ones reminded, gone ones
/// told.
pub async fn check(st: &State, user: &str) -> anyhow::Result<()> {
    let now = problems(st, user).await?;
    for (key, text) in &now {
        sqlx::query(
            "INSERT INTO db_pigeon_health_alerts (user_id, key, text, since) VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, key) DO UPDATE SET text = EXCLUDED.text",
        )
        .bind(user)
            .bind(key)
            .bind(text)
            .execute(&st.pool)
            .await?;
    }
    let due: Vec<(String, String)> = sqlx::query_as(
        "UPDATE db_pigeon_health_alerts SET notified_at = NOW()
          WHERE user_id = $3 AND since <= NOW() - make_interval(mins => $1) AND (notified_at IS NULL OR notified_at < NOW() - make_interval(hours => $2))
          RETURNING key, text",
    )
    .bind(AFTER_MINUTES as i32)
    .bind(REMIND_HOURS as i32)
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    for (key, text) in due {
        log::warn!("health: {key}: {text}");
        cards::alert(st, user, &format!("⚠ {text}")).await;
    }
    let keys: Vec<String> = now.into_iter().map(|(k, _)| k).collect();
    let gone: Vec<(String, Option<DateTime<Utc>>)> =
        sqlx::query_as("DELETE FROM db_pigeon_health_alerts WHERE user_id = $2 AND NOT (key = ANY($1)) RETURNING key, notified_at")
            .bind(&keys)
            .bind(user)
            .fetch_all(&st.pool)
            .await?;
    for (key, notified) in gone {
        if notified.is_some() {
            log::info!("health: {key} resolved");
            cards::alert(st, user, &format!("✅ {}", fixed(&key))).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::fixed;

    #[test]
    fn back_to_normal() {
        assert_eq!(fixed("conn:instagram:@someone"), "Instagram @someone works again");
        assert_eq!(fixed("stale:gmail:a@b.com"), "Gmail a@b.com syncs again");
        assert_eq!(fixed("whatsapp:bridge"), "WhatsApp is connected again");
        assert_eq!(fixed("part:triage"), "triage works again");
    }
}
