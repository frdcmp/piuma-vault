use sqlx::{postgres::PgPoolOptions, Postgres, Pool};
use std::env;

pub type DbPool = Pool<Postgres>;

pub async fn create_pool() -> Result<DbPool, sqlx::Error> {
    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| {
            let host = env::var("DB_HOST").unwrap_or_else(|_| "db".to_string());
            let port = env::var("DB_PORT").unwrap_or_else(|_| "3306".to_string());
            let user = env::var("DB_USER").unwrap_or_else(|_| "user".to_string());
            let password = env::var("DB_PASSWORD").unwrap_or_else(|_| "password".to_string());
            let name = env::var("DB_NAME").unwrap_or_else(|_| "database".to_string());

            format!("postgres://{}:{}@{}:{}/{}", user, password, host, port, name)
        });

    // Optimized for high-performance async operations
    PgPoolOptions::new()
        .max_connections(10)  // Increased for high concurrency
        .min_connections(2)   // Keep some connections alive
        .acquire_timeout(std::time::Duration::from_secs(30))
        .idle_timeout(std::time::Duration::from_secs(600))
        .max_lifetime(std::time::Duration::from_secs(1800))
        .connect(&database_url)
        .await
}
