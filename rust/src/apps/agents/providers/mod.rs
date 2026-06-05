//! Provider adapters. Only DeepSeek for now (OpenAI-compatible wire format);
//! a `ProviderAdapter` trait + more backends (anthropic/openai/gemini/minimax)
//! come when a second provider is added — see the plan.

pub mod deepseek;
pub mod openclaw;
