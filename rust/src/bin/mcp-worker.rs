//! MCP Worker — single owner of every outbound MCP connection. Loads the
//! `mcp_servers` table, keeps one rmcp client per enabled server (lazy connect,
//! dropped-and-redialed on failure), refreshes each server's `tool_cache`, and
//! serves a tiny internal HTTP API on the compose network (never published):
//!
//!   GET  /health                → per-server config + live connection state
//!   GET  /tools                 → merged OpenAI-format tool defs, namespaced
//!                                 `mcp__{server}__{tool}` (served from cache).
//!                                 `?scope=cron&allow_destructive=<bool>`
//!                                 narrows to cron_safe servers and (unless
//!                                 destructive was opted into) to tools the
//!                                 server annotates read-only/non-destructive.
//!   POST /call/{server}/{tool}  → body = args JSON; runs the tool under the
//!                                 row's `timeout_secs`, returns its result, or
//!                                 `{ "error": … }` with a non-2xx status
//!   POST /refresh/{server}      → reconnect + tools/list, update `tool_cache`
//!
//! Transports: 'http' (streamable HTTP; url + optional bearer token) and
//! 'stdio' (command+args spawned as a child of THIS process with a scrubbed
//! env — only PATH/HOME plus the row's `env`). The backend reaches this via
//! `apps::agents::mcp` (MCP_WORKER_URL). Keeping the connections here — not in
//! the backend — means one shared client set and tool cache across chat and
//! cron, dev-mode backend recompiles don't tear down MCP sessions, and stdio
//! children live in the one container whose image carries node/uv.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use actix_web::{web, App, HttpResponse, HttpServer};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientInfo, Implementation,
    PaginatedRequestParams, Tool,
};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use backend::db;
use backend::db::db::DbPool;

type McpClient = RunningService<RoleClient, ClientInfo>;

const ROW_COLS: &str = "id, name, transport, url, auth_token, command, args, env, cron_safe, \
    timeout_secs, tool_cache";

#[derive(sqlx::FromRow, Clone)]
struct ServerRow {
    id: uuid::Uuid,
    name: String,
    transport: String,
    url: String,
    auth_token: String,
    command: String,
    args: Vec<String>,
    env: Value,
    cron_safe: bool,
    timeout_secs: i32,
    tool_cache: Option<Value>,
}

struct Manager {
    pool: DbPool,
    clients: Mutex<HashMap<String, Arc<McpClient>>>,
}

/// Same rewrite as the provider adapters: inside the container, `localhost` in
/// a server URL means the docker host, not the container itself.
fn reach_host(url: &str) -> String {
    url.replace("://localhost", "://host.docker.internal")
        .replace("://127.0.0.1", "://host.docker.internal")
}

impl Manager {
    async fn load(&self, name: &str) -> Result<ServerRow, String> {
        sqlx::query_as::<_, ServerRow>(&format!(
            "SELECT {ROW_COLS} FROM mcp_servers WHERE name = $1 AND enabled"
        ))
        .bind(name)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| format!("db error: {e}"))?
        .ok_or_else(|| format!("no enabled MCP server named '{name}'"))
    }

    async fn load_enabled(&self, cron_only: bool) -> Vec<ServerRow> {
        sqlx::query_as::<_, ServerRow>(&format!(
            "SELECT {ROW_COLS} FROM mcp_servers WHERE enabled AND ($1 = false OR cron_safe) \
             ORDER BY name"
        ))
        .bind(cron_only)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_else(|e| {
            log::error!("mcp: load servers failed: {e}");
            Vec::new()
        })
    }

    async fn connect(&self, row: &ServerRow) -> Result<McpClient, String> {
        let info = ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("piuma-vault", env!("CARGO_PKG_VERSION")),
        );
        let handshake = Duration::from_secs(row.timeout_secs.clamp(5, 120) as u64);
        match row.transport.as_str() {
            "http" => {
                let mut config =
                    StreamableHttpClientTransportConfig::with_uri(reach_host(&row.url));
                let token = row.auth_token.trim();
                if !token.is_empty() {
                    config = config.auth_header(token.to_string());
                }
                let transport = StreamableHttpClientTransport::from_config(config);
                tokio::time::timeout(handshake, info.serve(transport))
                    .await
                    .map_err(|_| format!("'{}': MCP handshake timed out", row.name))?
                    .map_err(|e| format!("'{}': MCP connect failed: {e}", row.name))
            }
            "stdio" => {
                // Scrubbed env: the child gets PATH/HOME (npx/uvx need both for
                // resolution and their package caches) plus the row's own env —
                // never this process's DB credentials.
                let mut cmd = tokio::process::Command::new(&row.command);
                cmd.args(&row.args);
                cmd.env_clear();
                for key in ["PATH", "HOME"] {
                    if let Ok(v) = std::env::var(key) {
                        cmd.env(key, v);
                    }
                }
                if let Some(env) = row.env.as_object() {
                    for (k, v) in env {
                        if let Some(s) = v.as_str() {
                            cmd.env(k, s);
                        }
                    }
                }
                let transport = TokioChildProcess::new(cmd)
                    .map_err(|e| format!("'{}': spawn '{}' failed: {e}", row.name, row.command))?;
                tokio::time::timeout(handshake, info.serve(transport))
                    .await
                    .map_err(|_| format!("'{}': MCP handshake timed out", row.name))?
                    .map_err(|e| format!("'{}': MCP connect failed: {e}", row.name))
            }
            other => Err(format!("'{}': unknown transport '{other}'", row.name)),
        }
    }

    /// Get-or-dial the client for a server. The map lock is held across a dial
    /// (bounded by the handshake timeout) — fine at this worker's concurrency.
    async fn client_for(&self, row: &ServerRow) -> Result<Arc<McpClient>, String> {
        let mut clients = self.clients.lock().await;
        if let Some(c) = clients.get(&row.name) {
            return Ok(c.clone());
        }
        let client = Arc::new(self.connect(row).await?);
        clients.insert(row.name.clone(), client.clone());
        Ok(client)
    }

    /// Drop a (presumed broken) connection so the next call redials.
    async fn drop_client(&self, name: &str) {
        self.clients.lock().await.remove(name);
    }

    /// Reconnect and re-list a server's tools; persist the result (or failure)
    /// on the row. Returns the raw tools/list entries.
    async fn refresh(&self, row: &ServerRow) -> Result<Vec<Tool>, String> {
        self.drop_client(&row.name).await;
        let outcome = async {
            let client = self.client_for(row).await?;
            let mut result = client
                .list_tools(None)
                .await
                .map_err(|e| format!("'{}': tools/list failed: {e}", row.name))?;
            let mut tools = result.tools;
            while let Some(cursor) = result.next_cursor {
                result = client
                    .list_tools(Some(
                        PaginatedRequestParams::default().with_cursor(Some(cursor)),
                    ))
                    .await
                    .map_err(|e| format!("'{}': tools/list page failed: {e}", row.name))?;
                tools.extend(result.tools);
            }
            Ok::<Vec<Tool>, String>(tools)
        }
        .await;

        let (status, cache) = match &outcome {
            Ok(tools) => (
                format!("ok: {} tool(s)", tools.len()),
                Some(serde_json::to_value(tools).unwrap_or_else(|_| json!([]))),
            ),
            Err(e) => (format!("error: {e}"), None),
        };
        let res = sqlx::query(
            "UPDATE mcp_servers SET tool_cache = COALESCE($2, tool_cache), last_status = $3, \
             last_checked_at = NOW(), updated_at = NOW() WHERE id = $1",
        )
        .bind(row.id)
        .bind(&cache)
        .bind(&status)
        .execute(&self.pool)
        .await;
        if let Err(e) = res {
            log::error!("mcp: persist tool cache for '{}' failed: {e}", row.name);
        }
        outcome
    }
}

/// Flatten a CallToolResult into the single JSON value the agent loop expects.
/// Structured content wins; otherwise text blocks are joined (and passed
/// through as parsed JSON when they are JSON, which most servers emit).
fn normalise_result(result: &CallToolResult) -> Value {
    if let Some(s) = &result.structured_content {
        return s.clone();
    }
    let texts: Vec<&str> = result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.as_str()))
        .collect();
    let joined = texts.join("\n");
    let non_text = result.content.len() - texts.len();
    match serde_json::from_str::<Value>(&joined) {
        Ok(v) if non_text == 0 => v,
        _ if non_text > 0 => json!({
            "text": joined,
            "note": format!("{non_text} non-text content block(s) omitted"),
        }),
        _ => json!({ "text": joined }),
    }
}

async fn health(mgr: web::Data<Arc<Manager>>) -> HttpResponse {
    #[derive(sqlx::FromRow)]
    struct HealthRow {
        name: String,
        enabled: bool,
        url: String,
        last_status: Option<String>,
        last_checked_at: Option<chrono::DateTime<chrono::Utc>>,
        tool_count: Option<i32>,
    }
    let rows = sqlx::query_as::<_, HealthRow>(
        "SELECT name, enabled, url, last_status, last_checked_at, \
         jsonb_array_length(tool_cache)::int AS tool_count FROM mcp_servers ORDER BY name",
    )
    .fetch_all(&mgr.pool)
    .await
    .unwrap_or_default();
    let connected = mgr.clients.lock().await;
    let servers: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "name": r.name,
                "enabled": r.enabled,
                "url": r.url,
                "connected": connected.contains_key(&r.name),
                "tools": r.tool_count,
                "last_status": r.last_status,
                "last_checked_at": r.last_checked_at,
            })
        })
        .collect();
    HttpResponse::Ok().json(json!({ "status": "ok", "servers": servers }))
}

#[derive(Deserialize)]
struct ToolsQuery {
    /// "cron" narrows to cron_safe servers; anything else (or absent) = chat scope.
    scope: Option<String>,
    /// Cron only: when false (the default), keep only tools whose annotations
    /// mark them read-only or explicitly non-destructive. Unannotated tools are
    /// dropped — an unattended run shouldn't get tools nobody vouched for.
    allow_destructive: Option<bool>,
}

/// Whether a tool is safe for a headless run that did NOT opt into destructive
/// tools. MCP annotations are hints, but they're the only signal there is.
fn cron_readonly(tool: &Tool) -> bool {
    tool.annotations.as_ref().is_some_and(|a| {
        a.read_only_hint == Some(true) || a.destructive_hint == Some(false)
    })
}

async fn tools(mgr: web::Data<Arc<Manager>>, q: web::Query<ToolsQuery>) -> HttpResponse {
    let cron = q.scope.as_deref() == Some("cron");
    let allow_destructive = q.allow_destructive.unwrap_or(false);
    let mut out: Vec<Value> = Vec::new();
    for row in mgr.load_enabled(cron).await {
        // Serve from the cached tools/list; a server that has never been
        // listed (or whose last refresh failed) gets one live attempt.
        let cached: Option<Vec<Tool>> = row
            .tool_cache
            .clone()
            .and_then(|c| serde_json::from_value(c).ok());
        let tools = match cached {
            Some(t) => t,
            None => match mgr.refresh(&row).await {
                Ok(t) => t,
                Err(e) => {
                    log::warn!("mcp: skipping '{}' in /tools: {e}", row.name);
                    continue;
                }
            },
        };
        for t in tools {
            if cron && !allow_destructive && !cron_readonly(&t) {
                continue;
            }
            out.push(json!({
                "type": "function",
                "function": {
                    "name": format!("mcp__{}__{}", row.name, t.name),
                    "description": t.description.as_deref().unwrap_or(""),
                    "parameters": t.input_schema,
                },
            }));
        }
    }
    HttpResponse::Ok().json(out)
}

async fn call(
    mgr: web::Data<Arc<Manager>>,
    path: web::Path<(String, String)>,
    body: web::Json<Value>,
) -> HttpResponse {
    let (server, tool) = path.into_inner();
    let row = match mgr.load(&server).await {
        Ok(r) => r,
        Err(e) => return HttpResponse::NotFound().json(json!({ "error": e })),
    };
    let client = match mgr.client_for(&row).await {
        Ok(c) => c,
        Err(e) => return HttpResponse::BadGateway().json(json!({ "error": e })),
    };

    let args = body.into_inner().as_object().cloned().unwrap_or_default();
    let params = CallToolRequestParams::new(tool.clone()).with_arguments(args);
    let deadline = Duration::from_secs(row.timeout_secs.max(1) as u64);
    match tokio::time::timeout(deadline, client.call_tool(params)).await {
        Err(_) => {
            // A timed-out session may have an orphaned in-flight request; redial.
            mgr.drop_client(&server).await;
            HttpResponse::GatewayTimeout().json(json!({
                "error": format!("'{server}/{tool}' timed out after {}s", deadline.as_secs()),
            }))
        }
        Ok(Err(e)) => {
            mgr.drop_client(&server).await;
            HttpResponse::BadGateway()
                .json(json!({ "error": format!("'{server}/{tool}' failed: {e}") }))
        }
        Ok(Ok(result)) => {
            if result.is_error == Some(true) {
                let msg = normalise_result(&result);
                let text = msg
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| msg.to_string());
                return HttpResponse::UnprocessableEntity()
                    .json(json!({ "error": format!("'{server}/{tool}': {text}") }));
            }
            HttpResponse::Ok().json(normalise_result(&result))
        }
    }
}

async fn refresh(mgr: web::Data<Arc<Manager>>, path: web::Path<String>) -> HttpResponse {
    let name = path.into_inner();
    let row = match mgr.load(&name).await {
        Ok(r) => r,
        Err(e) => return HttpResponse::NotFound().json(json!({ "error": e })),
    };
    match mgr.refresh(&row).await {
        Ok(tools) => HttpResponse::Ok().json(json!({
            "server": name,
            "count": tools.len(),
            "tools": tools.iter().map(|t| t.name.as_ref()).collect::<Vec<&str>>(),
        })),
        Err(e) => HttpResponse::BadGateway().json(json!({ "error": e })),
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();
    log::info!("🔌 MCP Worker starting...");

    let pool = match db::db::create_pool().await {
        Ok(p) => {
            log::info!("✅ Database connection pool established");
            p
        }
        Err(e) => {
            log::error!("❌ Failed to connect to database: {e}");
            std::process::exit(1);
        }
    };

    let manager = Arc::new(Manager {
        pool,
        clients: Mutex::new(HashMap::new()),
    });

    // Warm the tool caches in the background — a dead server at boot must not
    // delay serving /tools for the healthy ones.
    let warm = manager.clone();
    tokio::spawn(async move {
        for row in warm.load_enabled(false).await {
            match warm.refresh(&row).await {
                Ok(t) => log::info!("mcp: '{}' connected, {} tool(s)", row.name, t.len()),
                Err(e) => log::warn!("mcp: warm-up for '{}' failed: {e}", row.name),
            }
        }
    });

    let data = web::Data::new(manager);
    let port: u16 = std::env::var("MCP_WORKER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8090);
    log::info!("🔌 MCP Worker listening on 0.0.0.0:{port}");
    HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .route("/health", web::get().to(health))
            .route("/tools", web::get().to(tools))
            .route("/call/{server}/{tool}", web::post().to(call))
            .route("/refresh/{server}", web::post().to(refresh))
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
