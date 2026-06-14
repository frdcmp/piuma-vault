use actix_web::{HttpResponse, Responder};

use super::models::ApiResponse;

/// Lightweight liveness check — confirms the API is reachable. Used by the
/// Docker healthcheck (`GET /health`) and the admin API-test page.
pub async fn health_check() -> impl Responder {
    HttpResponse::Ok().json(ApiResponse {
        message: "API is reachable".to_string(),
    })
}
