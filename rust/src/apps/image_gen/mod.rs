//! Image generation. A provider-adapter layer (`providers`) behind a single
//! `generate` dispatch, a shared `core` pipeline (generate → upload to S3 →
//! record history) used by both the HTTP API and the agent `generate_image`
//! tool, and the runtime config resolver (`config`) reading from `app_settings`
//! (admin → Services → Images). Adding a provider = one arm in `providers` plus
//! its key constants in `settings::store`.

pub mod config;
pub mod core;
pub mod handlers;
pub mod models;
pub mod providers;
pub mod routes;

pub use config::{list_models, test};
