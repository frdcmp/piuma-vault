pub mod handlers;
pub mod link;
pub mod models;
pub mod routes;

// Shared tag↔entity link sync used by tasks + calendar write paths.
pub use link::{find_or_create_bucket, sync_tags};
