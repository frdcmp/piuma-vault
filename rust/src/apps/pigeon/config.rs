//! Pigeon's settings from the environment (`.env.example` lists them). Read once at start; a
//! channel whose settings are missing is off (its connector says why). The models Pigeon writes
//! with are the vault's own (admin → Agents); only Jev, the classifier, is set here.

use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    /// Where the vault is reached from outside (`SITE_URL`): OAuth callbacks and links are built on it.
    pub public_url: String,
    pub jev: Option<JevConf>,
    pub google: Option<GoogleConf>,
    pub instagram: Option<InstagramConf>,
    pub whatsapp: Option<WhatsappConf>,
    /// The console channel (dev): messages typed in through the API, to see what Pigeon makes of them.
    pub console: bool,
    /// How long after the last incoming message a conversation is triaged (a burst is one batch).
    pub triage_debounce: Duration,
    pub gmail_poll: Duration,
    /// The suite's sign-in, whose access tokens the MCP takes too (`oauth`); none: only the vault's own.
    pub mcp_auth: Option<McpAuthConf>,
}

/// Jev, the classifier: an endpoint that answers yes/no, choice and score questions about a
/// state (`POST {url}/systemone`).
#[derive(Clone, Debug)]
pub struct JevConf {
    pub url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Debug)]
pub struct GoogleConf {
    pub client_id: String,
    pub client_secret: String,
}

/// Meta's app for the Instagram API with Unified Login: the app (its id and secret, which also
/// signs the webhook), the login configuration made in it, and the webhook's verify token.
#[derive(Clone, Debug)]
pub struct InstagramConf {
    pub app_id: String,
    pub app_secret: String,
    pub config_id: String,
    pub verify_token: Option<String>,
}

/// The WhatsApp bridge (`whatsapp-bridge/`), holding the user's WhatsApp as a linked device:
/// where it's reached, and the secret both sides share (its API's bearer, its events' signature).
#[derive(Clone, Debug)]
pub struct WhatsappConf {
    pub bridge_url: String,
    pub secret: String,
}

/// An OAuth authorization server whose access tokens the MCP takes (`oauth`): who signs them
/// (`iss`), where its keys are fetched from (`{url}/.well-known/jwks.json`, the issuer itself
/// unless it's reached another way), what the MCP is to it (`aud`), and its two scopes, the one
/// that reads and the one that also writes.
#[derive(Clone, Debug)]
pub struct McpAuthConf {
    pub issuer: String,
    pub url: String,
    pub resource: String,
    pub read_scope: String,
    pub write_scope: String,
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn secs(k: &str, default: u64) -> Duration {
    Duration::from_secs(var(k).and_then(|v| v.parse().ok()).unwrap_or(default))
}

impl Config {
    pub fn from_env() -> Config {
        let jev = match (var("PIGEON_JEV_URL"), var("PIGEON_JEV_KEY"), var("PIGEON_JEV_MODEL")) {
            (Some(url), Some(api_key), Some(model)) => Some(JevConf { url: url.trim_end_matches('/').into(), api_key, model }),
            _ => None,
        };
        let google = match (var("PIGEON_GOOGLE_CLIENT_ID"), var("PIGEON_GOOGLE_CLIENT_SECRET")) {
            (Some(client_id), Some(client_secret)) => Some(GoogleConf { client_id, client_secret }),
            _ => None,
        };
        let instagram = match (var("PIGEON_INSTAGRAM_APP_ID"), var("PIGEON_INSTAGRAM_APP_SECRET"), var("PIGEON_INSTAGRAM_CONFIG_ID")) {
            (Some(app_id), Some(app_secret), Some(config_id)) => {
                Some(InstagramConf { app_id, app_secret, config_id, verify_token: var("PIGEON_INSTAGRAM_WEBHOOK_VERIFY_TOKEN") })
            }
            _ => None,
        };
        let whatsapp = match (var("PIGEON_WHATSAPP_BRIDGE_URL"), var("PIGEON_WHATSAPP_BRIDGE_SECRET")) {
            (Some(url), Some(secret)) => Some(WhatsappConf { bridge_url: url.trim_end_matches('/').into(), secret }),
            _ => None,
        };
        let public_url: String = var("SITE_URL").unwrap_or_else(|| "http://localhost:8034".into()).trim_end_matches('/').into();
        let scopes = var("MCP_AUTH_SCOPES").unwrap_or_default();
        let mcp_auth = match (var("MCP_AUTH_ISSUER"), scopes.split_whitespace().collect::<Vec<_>>().as_slice()) {
            (Some(issuer), [read, write]) => Some(McpAuthConf {
                url: var("MCP_AUTH_URL").unwrap_or_else(|| issuer.clone()).trim_end_matches('/').into(),
                resource: var("MCP_AUTH_RESOURCE").unwrap_or_else(|| format!("{public_url}/api/v1/mcp")),
                read_scope: read.to_string(),
                write_scope: write.to_string(),
                issuer,
            }),
            _ => None,
        };
        Config {
            public_url,
            jev,
            google,
            instagram,
            whatsapp,
            console: matches!(var("PIGEON_CONSOLE").as_deref(), Some("1" | "true")),
            triage_debounce: secs("PIGEON_TRIAGE_DEBOUNCE_SECS", 20),
            gmail_poll: secs("PIGEON_GMAIL_POLL_SECS", 60),
            mcp_auth,
        }
    }

    /// The API as the outside world reaches it (Nginx adds `/api/v1`).
    pub fn api_url(&self) -> String {
        format!("{}/api/v1", self.public_url)
    }
}
