pub mod handlers;
pub mod link;
pub mod models;
pub mod routes;

// Shared tag↔entity link sync used by tasks + calendar write paths.
pub use link::sync_tags;
