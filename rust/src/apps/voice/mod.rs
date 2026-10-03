//! Speech-to-speech voice agent ("Jarvis"). A provider-adapter layer
//! (`providers`) over realtime speech-to-speech APIs, the runtime config
//! resolver (`config`) reading from `app_settings` (admin → Services → Voice),
//! and the HTTP API (`handlers`) that mints sessions, runs tool calls and
//! persists turns.
//! Adding a provider = one arm in `providers` + `config`, plus its key
//! constants in `settings::store`. Gemini Live is the only provider in v1.

pub mod config;
pub mod handlers;
pub mod models;
pub mod prompt;
pub mod providers;
pub mod routes;

pub use config::{list_models, test};
