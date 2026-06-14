//! Web Push (VAPID) dispatch. Sends an encrypted push to every browser
//! subscription registered for a user, and prunes dead endpoints (404/410).
//!
//! VAPID key material lives on disk in `src/keys/` (gitignored, like the JWT
//! keys); `build.rs` auto-generates it when missing:
//!   - `vapid_private.pem` — EC P-256 private key (SEC1 PEM), signs the pushes
//!   - `vapid_public.txt`  — base64url application server key the browser passes
//!                           to `pushManager.subscribe`
//!   - `vapid_subject.txt` — the VAPID `sub` contact URI (`mailto:` or `https://`)

use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

use crate::db::db::DbPool;

/// Directory holding the VAPID key files, relative to the crate working dir
/// (`/app` in Docker) — mirrors how the JWT keys resolve.
const KEYS_DIR: &str = "src/keys";

fn read_key_file(name: &str) -> Option<String> {
    std::fs::read_to_string(format!("{KEYS_DIR}/{name}"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The EC P-256 private key PEM used to sign pushes.
fn private_pem() -> Option<String> {
    read_key_file("vapid_private.pem")
}

/// The base64url application server key the browser subscribes with.
pub fn public_key() -> Option<String> {
    read_key_file("vapid_public.txt")
}

/// The VAPID `sub` claim — a contact URI for the push service operator. Falls
/// back to the canonical site URL (`SITE_URL`), then a generic placeholder.
pub fn subject() -> String {
    read_key_file("vapid_subject.txt")
        .or_else(|| {
            std::env::var("SITE_URL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "https://example.com".to_string())
}

/// Send `payload` (a JSON string consumed by the service worker) to all of the
/// user's browser subscriptions. Returns the number of successful deliveries.
pub async fn dispatch_web(pool: &DbPool, user_id: &str, payload: &str) -> usize {
    let Some(pem) = private_pem() else {
        log::warn!("VAPID private key not configured; skipping web push");
        return 0;
    };
    let subject = subject();

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
