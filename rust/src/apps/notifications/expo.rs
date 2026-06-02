//! Expo Push dispatch. POSTs to the Expo push service for every device token a
//! user has registered, and prunes tokens the service reports as unregistered.
//! No SDK needed — the existing `reqwest` client suffices.

use serde_json::json;

use crate::db::db::DbPool;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";

/// Send a push to all of the user's Expo device tokens. Returns the number of
/// messages the Expo service accepted ("ok").
pub async fn dispatch_expo(
    pool: &DbPool,
    user_id: &str,
    title: &str,
    body: &str,
    data: &serde_json::Value,
) -> usize {
    let tokens: Vec<String> =
        match sqlx::query_scalar("SELECT token FROM db_expo_push_tokens WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(pool)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                log::error!("expo push: failed to load tokens: {e}");
                return 0;
            }
        };

    if tokens.is_empty() {
        return 0;
    }

    let messages: Vec<serde_json::Value> = tokens
        .iter()
        .map(|t| {
            json!({
                "to": t,
                "title": title,
                "body": body,
                "sound": "default",
                "data": data,
            })
        })
        .collect();

    let client = reqwest::Client::new();
    let resp = match client.post(EXPO_PUSH_URL).json(&messages).send().await {
        Ok(r) => r,
        Err(e) => {
            log::error!("expo push: request failed: {e}");
            return 0;
        }
    };

    let parsed: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            log::error!("expo push: bad response: {e}");
            return 0;
        }
    };

    // Response: { "data": [ { "status": "ok" | "error", "details": { "error": "DeviceNotRegistered" } } ] }
    let mut ok = 0usize;
    if let Some(arr) = parsed.get("data").and_then(|d| d.as_array()) {
        for (i, ticket) in arr.iter().enumerate() {
            let status = ticket.get("status").and_then(|s| s.as_str()).unwrap_or("");
            if status == "ok" {
                ok += 1;
            } else {
                let detail = ticket
                    .get("details")
                    .and_then(|d| d.get("error"))
                    .and_then(|e| e.as_str())
                    .unwrap_or("");
                if detail == "DeviceNotRegistered" {
                    if let Some(token) = tokens.get(i) {
                        log::info!("expo push: pruning unregistered token");
                        let _ = sqlx::query("DELETE FROM db_expo_push_tokens WHERE token = $1")
                            .bind(token)
                            .execute(pool)
                            .await;
                    }
                }
            }
        }
    }

    ok
}
