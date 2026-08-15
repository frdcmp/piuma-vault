//! MCP server admin (Services → MCP). CRUD over the `mcp_servers` table plus
//! test/health proxies to the mcp-worker. The chat-side bridge that actually
//! serves tool schemas and routes calls lives in `apps::agents::mcp`.

pub mod handlers;
pub mod models;
pub mod routes;
