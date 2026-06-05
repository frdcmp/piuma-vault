//! Agents — multi-provider, multi-agent LLM chat. Agent-agnostic `/agents/*`
//! API; the agent is a parameter on the conversation row. See md/ plan.

pub mod chat;
pub mod handlers;
pub mod identities;
pub mod models;
pub mod providers;
pub mod registry;
pub mod routes;
pub mod seed;
