/*
 * SVO Portal - Rust API Server (v1)
 *
 * This is part of the SVO Portal microservices stack:
 * - Frontend: React/Vite application served at / (separate service)
 * - Backend Services:
 *   - Rust API (v1) at /BASE_URL/api/v1/ (this service)
 * - Database: PostGres with connection pooling
 * - Cache: Redis for high-performance caching
 * - Reverse Proxy: Nginx handling routing and load balancing
 *
 * The nginx configuration proxies all requests from /api/v1/
 * to this Rust server running on port 8080 in the container, providing a unified API gateway.
 */

use actix_web::{web, App, HttpServer, middleware::Logger};
use std::io;

mod db;
mod apps;
mod cors;

#[tokio::main]
async fn main() -> io::Result<()> {
    // Initialize logging
    env_logger::init();

    let base_url = std::env::var("BASE_URL").unwrap_or_else(|_| "/".to_string());
    
    println!("🚀 High-Speed Async Rust API Server starting");
    println!("📡 Accessible via Nginx proxy at: {}api/v1/", base_url);
    println!("🔧 Part of the stack - handles high-performance async operations");

    // Create optimized database connection pool for high-speed async operations
    let pool = match db::db::create_pool().await {
        Ok(pool) => {
            println!("✅ Database connection pool established (max: 20, min: 5 connections)");
            pool
        }
        Err(e) => {
            eprintln!("❌ Failed to connect to database: {}", e);
            return Err(io::Error::new(io::ErrorKind::Other, "Database connection failed"));
        }
    };

    // Initialize database
    match db::db_init::init_db(&pool).await {
        Ok(result) => {
            println!("✅ Database initialized successfully");
            if !result.tables_created.is_empty() {
                println!("📋 Tables created: {}", result.tables_created.join(", "));
            }
            if !result.tables_skipped.is_empty() {
                println!("⏭️  Tables skipped (already exist): {}", result.tables_skipped.join(", "));
            }
        }
        Err(e) => {
            eprintln!("❌ Failed to initialize database: {}", e);
            return Err(io::Error::new(io::ErrorKind::Other, format!("DB init failed: {}", e)));
        }
    }

    println!("⚡ Starting high-performance HTTP server...");

    // Auth rate limiter — shared across all workers / requests so the limits
    // apply to the whole process, not per-thread.
    let rate_limiter = apps::auth::rate_limit::RateLimiter::new();

    // Shared event bus for live note-change notifications (SSE). Any handler
    // that mutates a note publishes here; connected browsers re-fetch the
    // affected note via the regular auth-protected route.
    let notes_bus = apps::notes::events::NotesEventBus::new();

    // CORS policy is read from the environment once (see cors.rs) and used to
    // build a fresh middleware per worker.
    let cors_config = cors::CorsConfig::from_env();
    cors_config.log();

    // Configure HTTP server for maximum async performance
    HttpServer::new(move || {
        App::new()
            .wrap(cors_config.build())
            .wrap(Logger::default())   // Add request logging
            .app_data(web::Data::new(pool.clone()))
            .app_data(web::Data::new(rate_limiter.clone()))
            .app_data(web::Data::new(notes_bus.clone()))
            .configure(apps::health::routes::configure_routes)
            .configure(apps::auth::routes::configure_routes)
            .configure(apps::llm::routes::configure_routes)
            .configure(apps::api_keys::routes::configure_routes)
            .configure(apps::notes::routes::configure_routes)
            .configure(apps::shares::routes::configure_routes)
            .configure(apps::storage::routes::configure_routes)
            .configure(apps::settings::routes::configure_routes)
    })
    .workers(num_cpus::get() * 2)  // 2 workers per CPU core for high concurrency
    .backlog(2048)  // Increased backlog for handling burst traffic
    .max_connections(25000)  // High connection limit
    .max_connection_rate(1000)  // Connection rate limiting
    .keep_alive(std::time::Duration::from_secs(75))  // Optimized keep-alive
    .client_request_timeout(std::time::Duration::from_secs(30))
    .client_disconnect_timeout(std::time::Duration::from_millis(5000))  // 5 seconds
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
