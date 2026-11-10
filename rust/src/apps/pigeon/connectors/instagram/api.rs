//! Meta's Instagram API with Unified Login, as Pigeon uses it: the login dialog (Facebook Login for
//! Business with the app's configuration), the code → a Business Integration System User token
//! (owned by the user's business portfolio; it lasts as the configuration says, never by
//! default), graph.facebook.com calls with it (each carrying the appsecret_proof), and the
//! webhook's signature.

use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::Value as Json;
use sha2::Sha256;

use crate::apps::pigeon::config::InstagramConf;
use crate::apps::pigeon::sign;
use crate::apps::shares::crypto;
use crate::apps::pigeon::state::State;

const AUTH_URL: &str = "https://www.facebook.com/dialog/oauth";
pub const GRAPH: &str = "https://graph.facebook.com/v26.0";

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(30)).user_agent("piuma-vault-pigeon/1").build().expect("reqwest client"))
}

pub fn redirect_uri(st: &State) -> String {
    format!("{}/pigeon/connect/instagram/callback", st.cfg.api_url())
}

/// The login dialog: the configuration says what's asked (the Instagram account, its messages),
/// not a scope; `prompt=login` offers Instagram's login beside Facebook's. As the app's dashboard
/// writes it for the configuration.
pub fn login_url(c: &InstagramConf, redirect_uri: &str, state: &str) -> String {
    let q = [
        ("client_id", c.app_id.as_str()),
        ("config_id", c.config_id.as_str()),
        ("display", "popup"),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("override_default_response_type", "true"),
        ("prompt", "login"),
        ("state", state),
    ];
    let qs: Vec<String> = q.iter().map(|(k, v)| format!("{k}={}", urlencoding::encode(v))).collect();
    format!("{AUTH_URL}?{}", qs.join("&"))
}

/// Meta's refusal of a call.
#[derive(Debug)]
pub struct GraphError {
    pub what: String,
    pub status: u16,
    pub code: Option<i64>,
    /// Meta's finer code, when it gives one
    pub subcode: Option<i64>,
    pub message: String,
    /// what Meta would tell the person (`error_user_msg`), when it says
    pub hint: Option<String>,
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Instagram {}: {} {}", self.what, self.status, self.message)?;
        match (self.code, self.subcode) {
            (Some(c), Some(s)) => write!(f, " (code {c}, {s})")?,
            (Some(c), None) => write!(f, " (code {c})")?,
            _ => {}
        }
        match &self.hint {
            Some(h) => write!(f, ": {h}"),
            None => Ok(()),
        }
    }
}

impl std::error::Error for GraphError {}

impl GraphError {
    fn of(what: String, status: u16, body: &Json) -> GraphError {
        let message = body["error"]["message"].as_str().or(body["error_message"].as_str()).or(body["error"].as_str()).unwrap_or("no details").to_string();
        let hint = body["error"]["error_user_msg"].as_str().or(body["error"]["error_user_title"].as_str()).map(str::to_string);
        GraphError { what, status, code: body["error"]["code"].as_i64(), subcode: body["error"]["error_subcode"].as_i64(), message, hint }
    }
}

/// Meta found a parameter wrong (code 100): what was sent, not the account or its token.
pub fn bad_parameter(e: &anyhow::Error) -> bool {
    e.downcast_ref::<GraphError>().is_some_and(|g| g.code == Some(100))
}

/// The token no longer works (expired, the app removed from the business portfolio, the account
/// moved to another one): only connecting the account again helps.
pub fn token_dead(e: &anyhow::Error) -> bool {
    e.downcast_ref::<GraphError>().is_some_and(|g| g.code == Some(190))
}

/// Meta's request limit reached (the app's, the user's or the account's): nothing more until it
/// lets up, so stop rather than keep asking.
pub fn rate_limited(e: &anyhow::Error) -> bool {
    e.downcast_ref::<GraphError>().is_some_and(|g| matches!(g.code, Some(4 | 17 | 32 | 613 | 80002)))
}

/// The authorization code → (the system-user token, seconds it lasts when it ends at all).
pub async fn exchange(st: &State, c: &InstagramConf, code: &str) -> anyhow::Result<(String, Option<i64>)> {
    let res = http()
        .get(format!("{GRAPH}/oauth/access_token"))
        .query(&[
            ("client_id", c.app_id.as_str()),
            ("client_secret", c.app_secret.as_str()),
            ("redirect_uri", redirect_uri(st).as_str()),
            ("code", code),
        ])
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Meta unreachable: {}", e.without_url()))?;
    let status = res.status();
    let body: Json = res.json().await.unwrap_or(Json::Null);
    if !status.is_success() {
        return Err(GraphError::of("refused the code".into(), status.as_u16(), &body).into());
    }
    let token = body["access_token"].as_str().ok_or_else(|| anyhow::anyhow!("Meta's answer has no access_token"))?.to_string();
    Ok((token, body["expires_in"].as_i64().filter(|s| *s > 0)))
}

/// A token, with its appsecret_proof (the HMAC-SHA256 of the token under the app secret, which
/// Meta asks for when the app requires it).
pub struct Token {
    pub access: String,
    proof: String,
}

impl Token {
    pub fn new(c: &InstagramConf, access: String) -> Token {
        let mut mac = Hmac::<Sha256>::new_from_slice(c.app_secret.as_bytes()).expect("hmac takes any key");
        mac.update(access.as_bytes());
        Token { proof: hex::encode(mac.finalize().into_bytes()), access }
    }
}

/// A graph.facebook.com call with the account's token.
pub async fn graph(token: &Token, method: &str, path: &str, query: &[(&str, String)], body: Option<&Json>) -> anyhow::Result<Json> {
    let url = format!("{GRAPH}{path}");
    let mut req = if method == "POST" { http().post(&url) } else { http().get(&url) };
    req = req.bearer_auth(&token.access).query(query).query(&[("appsecret_proof", &token.proof)]);
    req = match body {
        Some(b) => req.json(b),
        None if method == "POST" => req.header(reqwest::header::CONTENT_LENGTH, "0"),
        None => req,
    };
    let res = req.send().await.map_err(|e| anyhow::anyhow!("Instagram unreachable: {}", e.without_url()))?;
    let status = res.status();
    let body: Json = res.json().await.unwrap_or(Json::Null);
    if !status.is_success() {
        return Err(GraphError::of(format!("{method} {path}"), status.as_u16(), &body).into());
    }
    Ok(body)
}

// Meta writes a message's id two ways: a webhook's `ig_dm_item:…` and the Graph API's
// `new_ig_dm_item:…`, the same message (the same numbers after). Each is that text in base64, Z
// written ZA and = written ZD. The Graph API knows only its own: a reaction on a webhook's id is
// refused ("Message ID is invalid", 2534002).
const WEBHOOK_MID: &str = "ig_dm_item:";
const API_MID: &str = "new_ig_dm_item:";

fn mid_text(mid: &str) -> Option<String> {
    let mut b64 = String::with_capacity(mid.len());
    let mut chars = mid.chars();
    while let Some(c) = chars.next() {
        match c {
            'Z' => b64.push(match chars.next()? {
                'A' => 'Z',
                'D' => '=',
                _ => return None,
            }),
            c => b64.push(c),
        }
    }
    String::from_utf8(base64::engine::general_purpose::STANDARD.decode(b64).ok()?).ok()
}

fn mid_of(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text).replace('Z', "ZA").replace('=', "ZD")
}

/// A message's id the other way Meta writes it; none: not one of the two.
pub fn other_mid(mid: &str) -> Option<String> {
    let text = mid_text(mid)?;
    if text.starts_with(WEBHOOK_MID) {
        Some(mid_of(&format!("new_{text}")))
    } else if text.starts_with(API_MID) {
        Some(mid_of(&text["new_".len()..]))
    } else {
        None
    }
}

/// A message's id as the Graph API writes it: a webhook's turned, any other as it is.
pub fn api_mid(mid: &str) -> String {
    match mid_text(mid) {
        Some(text) if text.starts_with(WEBHOOK_MID) => mid_of(&format!("new_{text}")),
        _ => mid.to_string(),
    }
}

/// The account's token (encrypted in `db_pigeon_connections`).
pub async fn token(st: &State, connection: i32) -> anyhow::Result<Token> {
    let c = st.cfg.instagram.as_ref().ok_or_else(|| anyhow::anyhow!("Instagram is not configured"))?;
    let sealed: Option<String> = sqlx::query_scalar("SELECT secret FROM db_pigeon_connections WHERE id = $1").bind(connection).fetch_optional(&st.pool).await?.flatten();
    let opened = crypto::decrypt(&st.pool, &sealed.ok_or_else(|| anyhow::anyhow!("no token stored"))?).await;
    let secret: Json = serde_json::from_str(&opened.ok_or_else(|| anyhow::anyhow!("the stored token can't be read: connect the account again"))?)?;
    let access = secret["access_token"].as_str().ok_or_else(|| anyhow::anyhow!("no token stored: connect the account again"))?;
    Ok(Token::new(c, access.to_string()))
}

/// Whether `header` (`sha256=<hex>`) is the HMAC-SHA256 of `body` under the app secret.
pub fn signature_ok(app_secret: &str, body: &[u8], header: Option<&str>) -> bool {
    sign::signature_ok(app_secret, body, header)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conf() -> InstagramConf {
        InstagramConf { app_id: "1234567890".into(), app_secret: "s3cret".into(), config_id: "777".into(), verify_token: None }
    }

    #[test]
    fn a_signature_is_checked() {
        let body = br#"{"object":"instagram"}"#;
        let mut mac = Hmac::<Sha256>::new_from_slice(b"s3cret").unwrap();
        mac.update(body);
        let good = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
        assert!(signature_ok("s3cret", body, Some(&good)));
        assert!(!signature_ok("other", body, Some(&good)), "another secret");
        assert!(!signature_ok("s3cret", br#"{"object":"instagrem"}"#, Some(&good)), "another body");
        assert!(!signature_ok("s3cret", body, None), "no header");
        assert!(!signature_ok("s3cret", body, Some("sha1=abc")), "not sha256");
        assert!(!signature_ok("s3cret", body, Some("sha256=zz")), "not hex");
    }

    #[test]
    fn the_login_url_carries_the_configuration() {
        let u = login_url(&conf(), "https://vault.example.com/api/v1/pigeon/connect/instagram/callback", "tok&1");
        assert!(u.starts_with("https://www.facebook.com/dialog/oauth?client_id=1234567890&config_id=777&display=popup&"));
        assert!(u.contains("redirect_uri=https%3A%2F%2Fvault.example.com%2Fapi%2Fv1%2Fpigeon%2Fconnect%2Finstagram%2Fcallback"));
        assert!(u.contains("response_type=code&override_default_response_type=true&prompt=login&state=tok%261"));
        assert!(!u.contains("scope="), "the configuration replaces the scope");
    }

    #[test]
    fn a_message_id_goes_both_ways() {
        let webhook = mid_of("ig_dm_item:1:IGMessageID:17841400000000001:340282366841710300000000000000000001:33098666936755470000000000000000001");
        assert!(webhook.starts_with("aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOj"), "as Meta writes a webhook's: {webhook}");
        let api = api_mid(&webhook);
        assert!(api.starts_with("bmV3X2lnX2RtX2l0ZAW06MTpJR01lc3NhZA2VJRDox"), "as Meta writes the API's: {api}");
        assert!(api.ends_with("ZD") && !api.contains('='), "the padding written ZD");
        assert_eq!(api_mid(&api), api, "the API's stays");
        assert_eq!(other_mid(&webhook).as_deref(), Some(api.as_str()));
        assert_eq!(other_mid(&api).as_deref(), Some(webhook.as_str()));
        assert_eq!(api_mid("m1"), "m1", "anything else as it is");
        assert_eq!(other_mid("m1"), None);
    }

    #[test]
    fn a_token_carries_its_proof() {
        let t = Token::new(&conf(), "EAAB".into());
        let mut mac = Hmac::<Sha256>::new_from_slice(b"s3cret").unwrap();
        mac.update(b"EAAB");
        assert_eq!(t.proof, hex::encode(mac.finalize().into_bytes()));
    }

    #[test]
    fn an_expired_token_is_told_apart() {
        let body = serde_json::json!({ "error": { "message": "Error validating access token", "type": "OAuthException", "code": 190 } });
        let dead: anyhow::Error = GraphError::of("GET /x".into(), 400, &body).into();
        assert!(token_dead(&dead));
        assert_eq!(dead.to_string(), "Instagram GET /x: 400 Error validating access token (code 190)");
        let other: anyhow::Error = GraphError::of("POST /x/messages".into(), 400, &serde_json::json!({ "error": { "message": "outside window", "code": 10 } })).into();
        assert!(!token_dead(&other));
        assert!(!token_dead(&anyhow::anyhow!("Instagram unreachable")));
    }
}
