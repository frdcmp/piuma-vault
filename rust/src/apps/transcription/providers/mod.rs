//! Per-provider streaming-transcription adapters. Each module owns one
//! service's wire format (token exchange, WS config, transcript JSON). Adding a
//! provider = one new module here plus the `kind` arms in the parent `mod.rs`.

pub mod speechmatics;
