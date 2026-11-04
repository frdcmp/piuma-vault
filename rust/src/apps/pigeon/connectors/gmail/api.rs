//! Google's OAuth and the Gmail API, as Pigeon uses them. Access tokens (an hour) are kept in
//! memory per connection and renewed from the refresh token (encrypted, `apps::shares::crypto`).

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value as Json};
use tokio::sync::Mutex;

use crate::apps::pigeon::config::GoogleConf;
use crate::apps::shares::crypto;
use crate::apps::pigeon::state::State;

pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GMAIL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
/// Read, label, archive and send: gmail.modify covers all of them.
pub const SCOPES: &str = "https://www.googleapis.com/auth/gmail.modify openid email";

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(30)).user_agent("piuma-vault-pigeon/1").build().expect("reqwest client"))
}

fn tokens() -> &'static Mutex<HashMap<i32, (String, Instant)>> {
    static T: OnceLock<Mutex<HashMap<i32, (String, Instant)>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn redirect_uri(st: &State) -> String {
    format!("{}/pigeon/connect/gmail/callback", st.cfg.api_url())
}

/// The authorization code → {access_token, refresh_token, expires_in}.
pub async fn exchange(st: &State, g: &GoogleConf, code: &str) -> anyhow::Result<Json> {
    let res = http()
        .post(TOKEN_URL)
        .form(&[
            ("code", code),
            ("client_id", g.client_id.as_str()),
            ("client_secret", g.client_secret.as_str()),
            ("redirect_uri", redirect_uri(st).as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await?;
    let status = res.status();
    let body: Json = res.json().await.unwrap_or(Json::Null);
    if !status.is_success() {
        anyhow::bail!("Google refused the code ({status}): {}", body["error_description"].as_str().or(body["error"].as_str()).unwrap_or(""));
    }
    Ok(body)
}

/// A live access token for a connection, renewed from its refresh token when needed.
pub async fn access_token(st: &State, connection: i32) -> anyhow::Result<String> {
    if let Some((t, until)) = tokens().lock().await.get(&connection) {
        if Instant::now() < *until {
            return Ok(t.clone());
        }
    }
    let g = st.cfg.google.as_ref().ok_or_else(|| anyhow::anyhow!("PIGEON_GOOGLE_CLIENT_ID / PIGEON_GOOGLE_CLIENT_SECRET are not set"))?;
    let sealed: Option<String> = sqlx::query_scalar("SELECT secret FROM db_pigeon_connections WHERE id = $1").bind(connection).fetch_optional(&st.pool).await?.flatten();
    let opened = crypto::decrypt(&st.pool, &sealed.ok_or_else(|| anyhow::anyhow!("no token stored"))?).await;
    let secret: Json = serde_json::from_str(&opened.ok_or_else(|| anyhow::anyhow!("the stored token can't be read: connect the account again"))?)?;
    let refresh = secret["refresh_token"].as_str().ok_or_else(|| anyhow::anyhow!("no refresh token stored: connect the account again"))?;
    let res = http()
        .post(TOKEN_URL)
        .form(&[
            ("refresh_token", refresh),
            ("client_id", g.client_id.as_str()),
            ("client_secret", g.client_secret.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    let status = res.status();
    let body: Json = res.json().await.unwrap_or(Json::Null);
    if !status.is_success() {
        anyhow::bail!(
            "Google refused the refresh token ({status}: {}): connect the account again",
            body["error_description"].as_str().or(body["error"].as_str()).unwrap_or("")
        );
    }
    let token = body["access_token"].as_str().ok_or_else(|| anyhow::anyhow!("Google's answer has no access_token"))?.to_string();
    let ttl = body["expires_in"].as_u64().unwrap_or(3600).saturating_sub(120);
    tokens().lock().await.insert(connection, (token.clone(), Instant::now() + Duration::from_secs(ttl)));
    Ok(token)
}

/// Forget a cached token (after a 401).
pub async fn forget(connection: i32) {
    tokens().lock().await.remove(&connection);
}

pub enum Got {
    Ok(Json),
    NotFound,
}

/// GET or POST on the Gmail API with an access token.
pub async fn gmail(token: &str, method: &str, path: &str, query: &[(&str, String)], body: Option<&Json>) -> anyhow::Result<Got> {
    let url = format!("{GMAIL}{path}");
    let mut req = if method == "POST" { http().post(&url) } else { http().get(&url) };
    req = req.bearer_auth(token).query(query);
    req = match body {
        Some(b) => req.json(b),
        // Google refuses a POST without a length (411): an empty one
        None if method == "POST" => req.header(reqwest::header::CONTENT_LENGTH, "0"),
        None => req,
    };
    let res = req.send().await.map_err(|e| anyhow::anyhow!("Gmail unreachable: {e}"))?;
    let status = res.status();
    if status.as_u16() == 404 {
        return Ok(Got::NotFound);
    }
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("Gmail {method} {path}: {} {}", status.as_u16(), text.chars().take(300).collect::<String>());
    }
    Ok(Got::Ok(serde_json::from_str(&text).unwrap_or_else(|_| json!({}))))
}

/// Send a whole message (RFC 822, attachments and all) in `thread`, through the upload endpoint:
/// a message with files is larger than a JSON body takes.
pub async fn send_upload(token: &str, thread: &str, message: String) -> anyhow::Result<Json> {
    let boundary = format!("pigeon-{}", uuid::Uuid::new_v4().simple());
    let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n", json!({ "threadId": thread }));
    body.push_str(&format!("--{boundary}\r\nContent-Type: message/rfc822\r\n\r\n"));
    body.push_str(&message);
    body.push_str(&format!("\r\n--{boundary}--\r\n"));
    let res = reqwest::Client::new()
        .post("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart")
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, format!("multipart/related; boundary={boundary}"))
        .body(body)
        .timeout(Duration::from_secs(5 * 60))
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Gmail unreachable: {e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("Gmail upload send: {} {}", status.as_u16(), text.chars().take(300).collect::<String>());
    }
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| json!({})))
}

/// The same, where a 404 is an error too.
pub async fn gmail_ok(token: &str, method: &str, path: &str, query: &[(&str, String)], body: Option<&Json>) -> anyhow::Result<Json> {
    match gmail(token, method, path, query, body).await? {
        Got::Ok(v) => Ok(v),
        Got::NotFound => anyhow::bail!("Gmail {method} {path}: not found"),
    }
}
