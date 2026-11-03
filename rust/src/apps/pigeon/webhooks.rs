//! What providers push: `/pigeon/webhooks/{connector}`. GET is the provider checking the endpoint
//! (the connector says what to echo back), POST a delivery (the connector checks its signature
//! and takes it in). A delivery is answered 200 at once, even when its content can't be used, so
//! the provider doesn't retry it forever; a bad signature is 403.

use std::collections::HashMap;

use actix_web::{web, HttpRequest, HttpResponse};

use crate::apps::pigeon::connectors;
use crate::apps::pigeon::state::AppState;

pub async fn verify(st: web::Data<AppState>, path: web::Path<String>, q: web::Query<HashMap<String, String>>) -> HttpResponse {
    let Some(c) = connectors::find(&st, &path.into_inner()) else { return HttpResponse::NotFound().finish() };
    match c.webhook_verify(&st, &q) {
        Some(challenge) => HttpResponse::Ok().content_type("text/plain").body(challenge),
        None => HttpResponse::Forbidden().finish(),
    }
}

pub async fn deliver(st: web::Data<AppState>, path: web::Path<String>, req: HttpRequest, body: web::Bytes) -> HttpResponse {
    let connector = path.into_inner();
    let Some(c) = connectors::find(&st, &connector) else { return HttpResponse::NotFound().finish() };
    // Meta and pigeon-whatsapp sign the body
    let signature = req.headers().get("x-hub-signature-256").and_then(|v| v.to_str().ok());
    match c.webhook(&st, signature, &body).await {
        Ok(true) => HttpResponse::Ok().body("ok"),
        Ok(false) => {
            log::warn!("pigeon webhook {connector}: refused (signature)");
            HttpResponse::Forbidden().finish()
        }
        Err(e) => {
            log::warn!("pigeon webhook {connector}: {e:#}");
            HttpResponse::Ok().body("ok")
        }
    }
}
