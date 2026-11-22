//! The suite's sign-in at the MCP, and nowhere else in the vault: an OAuth access token its
//! gateway mints for one person, a few minutes long, sent as `Authorization: Bearer`. It's signed
//! RS256 by the issuer (`MCP_AUTH_ISSUER`) with the key its `kid` names, from the issuer's JWKS
//! (fetched when a `kid` isn't known yet, at most once a minute, and again after an hour); it's
//! for this MCP (`aud`, `MCP_AUTH_RESOURCE`) and of type `oauth_access`. Its person is the
//! verified vault account with its email (any case); none: 403.
//!
//! What it may do is its scopes, as the vault's own: the read scope every read the MCP serves
//! (`inbox.read`, `notes.read`, `tasks.read`, `calendar.read`), the write scope every write
//! (`inbox.write`, `notes.write`, `tasks.write`, `calendar.write`). Never `inbox.access` (who may
//! be told what): only a vault key that carries it decides that. The rules every caller is under
//! (drafts, not sends; cards for big changes; never auto unless asked) are the tools' own and
//! don't change.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use actix_web::{error::InternalError, HttpRequest, HttpResponse};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, get_current_timestamp, jwk::{AlgorithmParameters, Jwk}, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Value as Json};
use tokio::sync::Mutex;

use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::pigeon::config::McpAuthConf;
use crate::db::db::DbPool;

/// How far the issuer's clock may be from the vault's.
const LEEWAY: u64 = 30;
/// The longest a token lives (the gateway's live five minutes): one that lives longer isn't its.
const MAX_LIFE: u64 = 5 * 60;
/// The keys are fetched again for an unknown `kid` no sooner than this after the last try…
const RETRY: Duration = Duration::from_secs(60);
/// …and anyway once they're this old, so a key the issuer dropped stops working here too.
const KEYS_TTL: Duration = Duration::from_secs(60 * 60);
const TOKEN_TYPE: &str = "oauth_access";

#[derive(Debug, Deserialize)]
struct Claims {
    email: String,
    #[serde(default)]
    scope: String,
    #[serde(default)]
    client_id: Option<String>,
    token_type: String,
    exp: u64,
}

/// Why a token isn't taken.
#[derive(Debug)]
pub enum Refused {
    /// Not a good token (signature, issuer, audience, time, type): 401, with where to sign in.
    Invalid(String),
    /// A good token, but its person has no account in the vault: 403.
    NoAccount,
    /// The issuer's keys or the vault's accounts can't be read right now: 503.
    Unavailable(String),
}

impl Refused {
    pub fn into_error(self, conf: &McpAuthConf) -> actix_web::Error {
        let (mut res, msg) = match self {
            Refused::Invalid(why) => {
                log::warn!("MCP: an access token from {} refused: {why}", conf.issuer);
                let mut res = HttpResponse::Unauthorized();
                res.insert_header(("WWW-Authenticate", format!("Bearer resource_metadata=\"{}\"", metadata_url(conf))));
                (res, "Invalid authentication token")
            }
            Refused::NoAccount => (HttpResponse::Forbidden(), "No account in the vault has this email"),
            Refused::Unavailable(why) => {
                log::error!("MCP: an access token from {} not checked: {why}", conf.issuer);
                (HttpResponse::ServiceUnavailable(), "Can't check the token right now")
            }
        };
        InternalError::from_response(msg, res.json(json!({ "error": msg }))).into()
    }
}

/// Where a client learns how to sign in for the MCP: the issuer's metadata for its own `/mcp`,
/// which is the gateway in front of this one.
fn metadata_url(conf: &McpAuthConf) -> String {
    format!("{}/.well-known/oauth-protected-resource/mcp", conf.issuer.trim_end_matches('/'))
}

/// The bearer token, when its issuer is this one: read before the token is checked, only to tell
/// it from the vault's own sign-in.
pub fn ours(req: &HttpRequest, conf: &McpAuthConf) -> Option<String> {
    let header = req.headers().get("Authorization")?.to_str().ok()?;
    let token = header.strip_prefix("Bearer ").or_else(|| header.strip_prefix("bearer "))?.trim();
    (issuer_of(token)? == conf.issuer).then(|| token.to_string())
}

fn issuer_of(token: &str) -> Option<String> {
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    serde_json::from_slice::<Json>(&payload).ok()?.get("iss")?.as_str().map(str::to_string)
}

/// The caller behind a token of ours: the vault account, with what its scopes allow, and who
/// calls for them (the OAuth client), to mark what it sends as its.
pub async fn caller(pool: &DbPool, conf: &McpAuthConf, token: &str) -> Result<(AuthenticatedUser, String), Refused> {
    let header = decode_header(token).map_err(|e| Refused::Invalid(e.to_string()))?;
    let kid = header.kid.ok_or_else(|| Refused::Invalid("no kid".into()))?;
    let key = key(conf, &kid).await?;
    let claims = check(token, &key, conf)?;
    let account = account(pool, &claims.email).await.map_err(|e| Refused::Unavailable(e.to_string()))?.ok_or(Refused::NoAccount)?;
    let user = AuthenticatedUser {
        user_id: account.0,
        email: account.1,
        first_name: account.2,
        last_name: account.3,
        permissions: permissions(&claims.scope, conf),
        groups: vec![],
        via_api_key: false,
    };
    Ok((user, claims.client_id.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "an assistant".into())))
}

fn check(token: &str, key: &DecodingKey, conf: &McpAuthConf) -> Result<Claims, Refused> {
    let mut v = Validation::new(Algorithm::RS256);
    v.leeway = LEEWAY;
    v.set_issuer(&[&conf.issuer]);
    v.set_audience(&[&conf.resource]);
    v.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let claims = decode::<Claims>(token, key, &v).map_err(|e| Refused::Invalid(e.to_string()))?.claims;
    if claims.token_type != TOKEN_TYPE {
        return Err(Refused::Invalid(format!("token_type {}", claims.token_type)));
    }
    if claims.exp > get_current_timestamp() + MAX_LIFE + LEEWAY {
        return Err(Refused::Invalid("lives longer than an access token".into()));
    }
    if claims.email.trim().is_empty() {
        return Err(Refused::Invalid("no email".into()));
    }
    Ok(claims)
}

/// What the read scope gives: every read the MCP serves.
const READS: &[&str] = &["inbox.read", "notes.read", "tasks.read", "calendar.read"];
/// What the write scope gives: every write it serves, but who may be told what (`inbox.access`).
const WRITES: &[&str] = &["inbox.write", "notes.write", "tasks.write", "calendar.write"];

/// The vault's scopes for the token's: its read scope reads, its write scope writes.
fn permissions(scope: &str, conf: &McpAuthConf) -> Vec<String> {
    let has = |s: &str| scope.split_whitespace().any(|x| x == s);
    let mut out: Vec<String> = Vec::new();
    if has(&conf.read_scope) {
        out.extend(READS.iter().map(|s| s.to_string()));
    }
    if has(&conf.write_scope) {
        out.extend(WRITES.iter().map(|s| s.to_string()));
    }
    out
}

/// The one verified account with this email, in any case (two that differ only in case: none).
async fn account(pool: &DbPool, email: &str) -> Result<Option<(String, String, Option<String>, Option<String>)>, sqlx::Error> {
    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT u.id, u.email, p.first_name, p.last_name FROM db_users u LEFT JOIN db_user_profiles p ON p.user_id = u.id \
         WHERE lower(u.email) = lower($1) AND u.is_verified",
    )
    .bind(email.trim())
    .fetch_all(pool)
    .await?;
    Ok(if rows.len() == 1 { rows.into_iter().next() } else { None })
}

/// The issuer's keys by `kid`: when they were last tried and last fetched, and whether that try failed.
struct Keys {
    by_kid: HashMap<String, DecodingKey>,
    fetched: Option<Instant>,
    tried: Option<Instant>,
    failed: bool,
}

static KEYS: OnceLock<Mutex<Keys>> = OnceLock::new();

async fn key(conf: &McpAuthConf, kid: &str) -> Result<DecodingKey, Refused> {
    let mut keys = KEYS.get_or_init(|| Mutex::new(Keys { by_kid: HashMap::new(), fetched: None, tried: None, failed: false })).lock().await;
    let stale = keys.fetched.is_none_or(|t| t.elapsed() > KEYS_TTL);
    let may_try = keys.tried.is_none_or(|t| t.elapsed() > RETRY);
    if (stale || !keys.by_kid.contains_key(kid)) && may_try {
        keys.tried = Some(Instant::now());
        match fetch(&conf.url).await {
            Ok(by_kid) => {
                keys.by_kid = by_kid;
                keys.fetched = Some(Instant::now());
                keys.failed = false;
            }
            Err(e) => {
                log::error!("MCP: the keys of {} not fetched: {e:#}", conf.issuer);
                keys.failed = true;
                if stale {
                    keys.by_kid.clear();
                }
            }
        }
    }
    match keys.by_kid.get(kid) {
        Some(key) => Ok(key.clone()),
        None if keys.failed => Err(Refused::Unavailable("the issuer's keys can't be fetched".into())),
        None => Err(Refused::Invalid(format!("unknown kid {kid}"))),
    }
}

async fn fetch(url: &str) -> anyhow::Result<HashMap<String, DecodingKey>> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(5)).build().expect("an HTTP client"));
    let set: Json = client.get(format!("{url}/.well-known/jwks.json")).send().await?.error_for_status()?.json().await?;
    Ok(keys_from(&set))
}

/// The RSA keys of a JWKS that have a `kid`; the rest are skipped.
fn keys_from(set: &Json) -> HashMap<String, DecodingKey> {
    set.get("keys")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|k| serde_json::from_value::<Jwk>(k.clone()).ok())
        .filter(|jwk| matches!(jwk.algorithm, AlgorithmParameters::RSA(_)))
        .filter_map(|jwk| Some((jwk.common.key_id.clone()?, DecodingKey::from_jwk(&jwk).ok()?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};

    // The dev pair `build.rs` makes (`src/keys/`), standing in for the issuer's.
    fn pem(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/src/keys/{name}", env!("CARGO_MANIFEST_DIR"))).expect("the dev keys")
    }

    fn conf() -> McpAuthConf {
        McpAuthConf {
            issuer: "https://signin.example.com".into(),
            url: "http://signin.internal".into(),
            resource: "https://vault.example.com/api/v1/mcp".into(),
            read_scope: "suite:read".into(),
            write_scope: "suite:write".into(),
        }
    }

    fn token(edit: impl FnOnce(&mut Json)) -> String {
        let now = get_current_timestamp();
        let mut claims = json!({
            "iss": "https://signin.example.com", "sub": "42", "email": "Someone@Example.com",
            "aud": "https://vault.example.com/api/v1/mcp", "scope": "suite:read suite:write",
            "client_id": "a-client", "token_type": "oauth_access", "iat": now, "exp": now + 300, "jti": "j1",
        });
        edit(&mut claims);
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("k1".into());
        encode(&header, &claims, &EncodingKey::from_rsa_pem(&pem("jwt-private.pem")).unwrap()).unwrap()
    }

    fn checked(t: &str) -> Result<Claims, Refused> {
        check(t, &DecodingKey::from_rsa_pem(&pem("jwt-public.pem")).unwrap(), &conf())
    }

    #[test]
    fn a_good_token() {
        let c = checked(&token(|_| {})).unwrap();
        assert_eq!(c.email, "Someone@Example.com");
        assert_eq!(c.client_id.as_deref(), Some("a-client"));
    }

    #[test]
    fn refused_when_not_for_here() {
        let refused = |edit: fn(&mut Json)| matches!(checked(&token(edit)), Err(Refused::Invalid(_)));
        assert!(refused(|c| c["iss"] = json!("https://elsewhere.example.com")));
        assert!(refused(|c| c["aud"] = json!("https://other.example.com/mcp")));
        assert!(refused(|c| c["token_type"] = json!("access")));
        assert!(refused(|c| c["exp"] = json!(get_current_timestamp() - 120)));
        assert!(refused(|c| c["exp"] = json!(get_current_timestamp() + 3600)));
        assert!(refused(|c| c["email"] = json!(" ")));
        assert!(refused(|c| {
            c.as_object_mut().unwrap().remove("aud");
        }));
    }

    #[test]
    fn refused_when_tampered_or_not_rs256() {
        let t = token(|_| {});
        let mut parts: Vec<String> = t.split('.').map(String::from).collect();
        parts[1] = URL_SAFE_NO_PAD.encode(br#"{"iss":"https://signin.example.com","sub":"1","email":"x@example.com","aud":"https://vault.example.com/api/v1/mcp","scope":"suite:write","token_type":"oauth_access","exp":9999999999}"#);
        assert!(matches!(checked(&parts.join(".")), Err(Refused::Invalid(_))));
        let hs = encode(&Header::new(Algorithm::HS256), &json!({ "iss": "https://signin.example.com" }), &EncodingKey::from_secret(b"s")).unwrap();
        assert!(matches!(checked(&hs), Err(Refused::Invalid(_))));
    }

    #[test]
    fn the_issuer_read_to_choose() {
        assert_eq!(issuer_of(&token(|_| {})).as_deref(), Some("https://signin.example.com"));
        assert_eq!(issuer_of("not a token"), None);
    }

    #[test]
    fn scopes_as_the_vaults() {
        let c = conf();
        assert_eq!(permissions("suite:read", &c), vec!["inbox.read", "notes.read", "tasks.read", "calendar.read"]);
        assert_eq!(
            permissions("suite:read suite:write", &c),
            vec!["inbox.read", "notes.read", "tasks.read", "calendar.read", "inbox.write", "notes.write", "tasks.write", "calendar.write"]
        );
        assert_eq!(permissions("suite:write", &c), vec!["inbox.write", "notes.write", "tasks.write", "calendar.write"]);
        assert!(permissions("other:read inbox.access notes.write", &c).is_empty());
        assert!(!permissions("suite:read suite:write", &c).iter().any(|p| p == "inbox.access" || p == "admin_access" || p.ends_with(".manage")));
    }

    /// What a token's person may run at the MCP: every vault read with the read scope, the
    /// writes only with the write scope, never who may be told what.
    #[test]
    fn a_token_runs_what_its_scopes_allow() {
        use crate::apps::agents::tools::vault_mcp;
        use crate::apps::auth::middleware::check_permission;
        use crate::apps::pigeon::tools;
        let person = |scope: &str| AuthenticatedUser {
            user_id: "u".into(),
            email: "someone@example.com".into(),
            first_name: None,
            last_name: None,
            permissions: permissions(scope, &conf()),
            groups: vec![],
            via_api_key: false,
        };
        let may = |u: &AuthenticatedUser, any: &[&str]| any.iter().any(|s| check_permission(u, s));
        let (reader, writer) = (person("suite:read"), person("suite:read suite:write"));
        for t in vault_mcp::defs() {
            assert_eq!(may(&reader, t.scopes()), t.read_only(), "{}", t.name);
            assert!(may(&writer, t.scopes()), "{}", t.name);
        }
        for name in tools::names() {
            let scope = tools::scope(name);
            assert_eq!(check_permission(&reader, scope), scope == "inbox.read", "{name}");
            assert_eq!(check_permission(&writer, scope), scope != "inbox.access", "{name}");
        }
    }

    #[test]
    fn keys_by_kid() {
        // RFC 7517's example RSA key, a symmetric key and one without a kid
        let set = json!({ "keys": [
            { "kty": "RSA", "kid": "2011-04-29", "use": "sig", "alg": "RS256", "e": "AQAB",
              "n": "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw" },
            { "kty": "oct", "kid": "s", "k": "c2VjcmV0" },
            { "kty": "RSA", "e": "AQAB", "n": "0vx7" },
        ]});
        let keys = keys_from(&set);
        assert!(keys.contains_key("2011-04-29"));
        assert_eq!(keys.len(), 1);
    }
}
