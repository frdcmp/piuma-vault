//! Web Push (VAPID) dispatch. Sends an encrypted push to every browser
//! subscription registered for a user, and prunes dead endpoints (404/410).
//!
//! VAPID keys come from the environment:
//!   - `VAPID_PRIVATE_KEY_PEM`  (PEM contents) or `VAPID_PRIVATE_KEY_PATH`
//!   - `VAPID_SUBJECT`          (e.g. `mailto:admin@example.com`)
//! The matching base64url public key (`VAPID_PUBLIC_KEY`) is what the browser
//! passes to `pushManager.subscribe`; generate the pair with `generate_vapid.py`.

use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

use crate::db::db::DbPool;

fn vapid_private_pem() -> Option<String> {
    if let Ok(pem) = std::env::var("VAPID_PRIVATE_KEY_PEM") {
        if !pem.trim().is_empty() {
            return Some(pem);
        }
    }
    if let Ok(path) = std::env::var("VAPID_PRIVATE_KEY_PATH") {
        if let Ok(pem) = std::fs::read_to_string(path) {
            return Some(pem);
        }
    }
    None
}

/// Send `payload` (a JSON string consumed by the service worker) to all of the
/// user's browser subscriptions. Returns the number of successful deliveries.
pub async fn dispatch_web(pool: &DbPool, user_id: &str, payload: &str) -> usize {
    let Some(pem) = vapid_private_pem() else {
        log::warn!("VAPID private key not configured; skipping web push");
        return 0;
    };
    let subject =
        std::env::var("VAPID_SUBJECT").unwrap_or_else(|_| "mailto:admin@example.com".to_string());

    let subs: Vec<(String, String, String)> = match sqlx::query_as(
        "SELECT endpoint, p256dh, auth FROM db_push_subscriptions WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            log::error!("web push: failed to load subscriptions: {e}");
            return 0;
        }
    };

    let client = HyperWebPushClient::new();
    let mut sent = 0usize;

    for (endpoint, p256dh, auth) in subs {
        let info = SubscriptionInfo::new(endpoint.clone(), p256dh, auth);

        let sig = match VapidSignatureBuilder::from_pem(pem.as_bytes(), &info) {
            Ok(mut b) => {
                b.add_claim("sub", subject.clone());
                match b.build() {
                    Ok(s) => s,
                    Err(e) => {
                        log::error!("web push: vapid build failed: {e}");
                        continue;
                    }
                }
            }
            Err(e) => {
                log::error!("web push: vapid from_pem failed: {e}");
                continue;
            }
        };

        let mut builder = WebPushMessageBuilder::new(&info);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
        builder.set_vapid_signature(sig);

        let message = match builder.build() {
            Ok(m) => m,
            Err(e) => {
                log::error!("web push: message build failed: {e}");
                continue;
            }
        };

        match client.send(message).await {
            Ok(_) => sent += 1,
            Err(WebPushError::EndpointNotValid) | Err(WebPushError::EndpointNotFound) => {
                log::info!("web push: pruning dead endpoint");
                let _ = sqlx::query("DELETE FROM db_push_subscriptions WHERE endpoint = $1")
                    .bind(&endpoint)
                    .execute(pool)
                    .await;
            }
            Err(e) => log::error!("web push: send failed: {e}"),
        }
    }

    sent
}
