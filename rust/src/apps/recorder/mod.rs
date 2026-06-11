//! Recorder → Transcriber → Summarizer.
//!
//! Orchestrates a recording session: a WebSocket relay (`ws`) bridges browser
//! audio to a transcription provider (see `apps::transcription`), accumulates
//! the transcript (`session`), persists it to S3 + the `db_recording_sessions`
//! index, and summarises it into a vault note (`summarise`). The provider and
//! its key are configured in admin → Services; the LLM in admin → Agents.

pub mod handlers;
pub mod models;
pub mod routes;
pub mod session;
pub mod summarise;
pub mod ws;
