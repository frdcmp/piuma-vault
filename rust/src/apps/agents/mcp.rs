//! MCP bridge — thin HTTP client for the mcp-worker's internal API. The worker
//! (src/bin/mcp-worker.rs) owns every MCP connection and the per-server tool
//! cache; this module only fetches ready-made OpenAI-format schemas and routes
//! namespaced calls (`mcp__{server}__{tool}`) to it. Both functions degrade to
//! a no-op/-error when the worker is down so chat keeps working with the
//! built-in tools.

use std::time::Duration;

use serde_json::Value;

/// Namespace prefix for MCP tool names as seen by the model.
pub const TOOL_PREFIX: &str = "mcp__";

/// The worker never lets a call run past the server row's `timeout_secs`, so
/// this outer bound only covers a hung worker itself.
const CALL_TIMEOUT: Duration = Duration::from_secs(180);
const TOOLS_TIMEOUT: Duration = Duration::from_secs(5);
/// A refresh dials the server and lists tools — allow a slow handshake.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(130);

fn worker_url() -> String {
    std::env::var("MCP_WORKER_URL").unwrap_or_else(|_| "http://mcp-worker:8090".to_string())
}

async fn fetch_schemas(path_and_query: &str) -> Vec<Value> {
    let client = match reqwest::Client::builder().timeout(TOOLS_TIMEOUT).build() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    match client
        .get(format!("{}{path_and_query}", worker_url()))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<Vec<Value>>().await.unwrap_or_default()
        }
        Ok(resp) => {
            log::warn!("mcp: worker /tools returned {}", resp.status());
            Vec::new()
        }
        // Down/absent worker is a normal deployment state, not an error.
        Err(e) if e.is_connect() => {
            log::debug!("mcp: worker unreachable, skipping MCP tools: {e}");
            Vec::new()
        }
        Err(e) => {
            log::warn!("mcp: worker /tools failed: {e}");
            Vec::new()
        }
    }
}

/// OpenAI-format `tools` entries for every tool on every enabled MCP server,
/// already namespaced `mcp__{server}__{tool}` by the worker. Never errors — an
/// unreachable worker just means no MCP tools this turn.
pub async fn schemas() -> Vec<Value> {
    fetch_schemas("/tools").await
}

/// Cron variant: only `cron_safe` servers, and unless the job opted into
/// destructive tools, only tools the server annotates as read-only/
/// non-destructive (unannotated tools are excluded — the safe default).
pub async fn schemas_cron(allow_destructive: bool) -> Vec<Value> {
    fetch_schemas(&format!(
        "/tools?scope=cron&allow_destructive={allow_destructive}"
    ))
    .await
}

/// Route a namespaced tool call to the worker. The worker responds 200 with the
/// tool's JSON result, or a JSON `{ "error": … }` body on any failure (bad
/// server/tool, connect failure, per-server timeout, tool-reported error).
pub async fn call(name: &str, args: &Value) -> Result<Value, String> {
    let rest = name
        .strip_prefix(TOOL_PREFIX)
        .ok_or_else(|| format!("not an MCP tool: {name}"))?;
    let (server, tool) = rest
        .split_once("__")
        .ok_or_else(|| format!("malformed MCP tool name: {name}"))?;

    let client = reqwest::Client::builder()
        .timeout(CALL_TIMEOUT)
        .build()
        .map_err(|e| format!("mcp client init failed: {e}"))?;
    let resp = client
        .post(format!("{}/call/{server}/{tool}", worker_url()))
        .json(args)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                "MCP worker is not reachable".to_string()
            } else {
                format!("MCP call failed: {e}")
            }
        })?;
    read_worker_response(resp).await
}

/// Ask the worker to reconnect + re-list a server (the admin "Test" button).
/// Returns the worker's `{ server, count, tools }` payload.
pub async fn refresh(server_name: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(REFRESH_TIMEOUT)
        .build()
        .map_err(|e| format!("mcp client init failed: {e}"))?;
    let resp = client
        .post(format!("{}/refresh/{server_name}", worker_url()))
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                "MCP worker is not reachable (is the mcp-worker service running?)".to_string()
            } else {
                format!("MCP refresh failed: {e}")
            }
        })?;
    read_worker_response(resp).await
}

/// Live per-server connection state from the worker (admin UI status dots).
pub async fn health() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(TOOLS_TIMEOUT)
        .build()
        .map_err(|e| format!("mcp client init failed: {e}"))?;
    let resp = client
        .get(format!("{}/health", worker_url()))
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                "MCP worker is not reachable (is the mcp-worker service running?)".to_string()
            } else {
                format!("MCP health check failed: {e}")
            }
        })?;
    read_worker_response(resp).await
}

async fn read_worker_response(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("MCP worker returned invalid JSON: {e}"))?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|e| e.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("MCP worker returned {status}"));
        return Err(msg);
    }
    Ok(body)
}
