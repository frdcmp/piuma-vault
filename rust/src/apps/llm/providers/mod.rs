// Only the embedding provider remains — used by notes search + the
// embedding-worker. The chat providers/dispatch were removed with the
// LLM chat / agents features.
pub mod embedding;
