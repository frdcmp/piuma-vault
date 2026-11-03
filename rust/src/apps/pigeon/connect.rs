//! Connecting an account. In the Inbox's settings the user asks for a one-time link
//! (`POST /pigeon/connections/{connector}/link`, 10 minutes) and opens it: `/pigeon/connect/{token}`
//! sends the browser to the provider's consent screen with the token as OAuth's state; the
//! provider sends it back to `/pigeon/connect/{connector}/callback`, where the account is stored
//! for the link's user, the link used up, and the browser sent back to the Inbox's settings. The
//! token is the proof of who it is: a browser following a redirect carries no sign-in. A connector
//! paired with a code (WhatsApp's QR) is polled from the settings instead (`pairing`).

use std::collections::HashMap;

use actix_web::{web, HttpResponse};
use serde_json::{json, Value as Json};

use crate::apps::pigeon::connectors::{self, Pairing};
use crate::apps::pigeon::sign;
use crate::apps::pigeon::state::{AppState, State};

/// A link lasts this long.
const LINK_MINUTES: i32 = 10;

/// A one-time link to connect an account of `connector` for the user.
pub async fn link(st: &State, user: &str, connector: &str) -> anyhow::Result<String> {
    let c = connectors::find(st, connector).ok_or_else(|| anyhow::anyhow!("no connector {connector}"))?;
    c.available(st).map_err(|e| anyhow::anyhow!(e))?;
    if !c.connects_by_link() {
        anyhow::bail!("{} isn't connected by a link", c.title());
    }
    let token = sign::token();
    sqlx::query(
        "INSERT INTO db_pigeon_connect_links (token_sha, user_id, connector, expires_at) VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))",
    )
    .bind(sign::sha256(&token))
    .bind(user)
    .bind(connector)
    .bind(LINK_MINUTES)
    .execute(&st.pool)
    .await?;
    Ok(format!("{}/pigeon/connect/{token}", st.cfg.api_url()))
}

/// What the settings show while pairing with a code: the code, or that it's done.
pub async fn pairing(st: &State, user: &str, connector: &str) -> anyhow::Result<Json> {
    let c = connectors::find(st, connector).ok_or_else(|| anyhow::anyhow!("no connector {connector}"))?;
    c.available(st).map_err(|e| anyhow::anyhow!(e))?;
    Ok(match c.connect_pairing(st, user).await? {
        Pairing::Code { png_base64, how } => json!({ "state": "code", "qr_png": png_base64, "how": how }),
        Pairing::Waiting => json!({ "state": "waiting" }),
        Pairing::Connected(account) => json!({ "state": "connected", "account": account }),
    })
}

/// The link's user and connector, if the token is live (unexpired, unused).
async fn live(st: &State, token: &str) -> anyhow::Result<Option<(String, String)>> {
    Ok(sqlx::query_as("SELECT user_id, connector FROM db_pigeon_connect_links WHERE token_sha = $1 AND used_at IS NULL AND expires_at > NOW()")
        .bind(sign::sha256(token))
        .fetch_optional(&st.pool)
        .await?)
}

/// Back to the Inbox's settings, with how it went.
fn back(st: &State, connector: &str, outcome: Result<String, String>) -> HttpResponse {
    let q = match outcome {
        Ok(account) => format!("connected={}&account={}", urlencoding::encode(connector), urlencoding::encode(&account)),
        Err(e) => format!("connector={}&error={}", urlencoding::encode(connector), urlencoding::encode(&e)),
    };
    HttpResponse::Found()
        .insert_header(("location", format!("{}/inbox/settings?{q}", st.cfg.public_url)))
        .insert_header(("referrer-policy", "no-referrer"))
        .insert_header(("cache-control", "no-store"))
        .finish()
}

pub async fn start(st: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let token = path.into_inner();
    let connector = match live(&st, &token).await {
        Ok(Some((_, c))) => c,
        Ok(None) => return back(&st, "", Err("the link has expired: ask for a new one".into())),
        Err(e) => {
            log::error!("pigeon connect: {e:#}");
            return back(&st, "", Err("the link can't be checked now: try again in a moment".into()));
        }
    };
    let Some(c) = connectors::find(&st, &connector) else { return back(&st, &connector, Err("no such connector".into())) };
    match c.connect_start(&st, &token).await {
        Ok(url) => HttpResponse::Found().insert_header(("location", url)).insert_header(("referrer-policy", "no-referrer")).finish(),
        Err(e) => back(&st, &connector, Err(format!("{e:#}"))),
    }
}

pub async fn finish(st: web::Data<AppState>, path: web::Path<String>, q: web::Query<HashMap<String, String>>) -> HttpResponse {
    let connector = path.into_inner();
    let Some(token) = q.get("state") else { return back(&st, &connector, Err("the provider sent no state".into())) };
    let user = match live(&st, token).await {
        Ok(Some((user, c))) if c == connector => user,
        Ok(_) => return back(&st, &connector, Err("the link has expired: ask for a new one".into())),
        Err(e) => {
            log::error!("pigeon connect: {e:#}");
            return back(&st, &connector, Err("the link can't be checked now: try again in a moment".into()));
        }
    };
    let Some(c) = connectors::find(&st, &connector) else { return back(&st, &connector, Err("no such connector".into())) };
    // used up before the provider is called: a link connects one account at most once
    if let Err(e) = sqlx::query("UPDATE db_pigeon_connect_links SET used_at = NOW() WHERE token_sha = $1").bind(sign::sha256(token)).execute(&st.pool).await {
        log::error!("pigeon connect: {e}");
        return back(&st, &connector, Err("the link can't be used now: try again in a moment".into()));
    }
    match c.connect_finish(&st, &user, &q).await {
        Ok(account) => {
            log::info!("pigeon connect: {connector} {account} connected for {user}");
            crate::apps::pigeon::events::publish(&st.pool, &user, "connections", None).await;
            back(&st, &connector, Ok(account))
        }
        Err(e) => {
            log::warn!("pigeon connect: {connector}: {e:#}");
            back(&st, &connector, Err(format!("{e:#}")))
        }
    }
}

/// The user's connection off: its token forgotten (the provider's session ended where it has
/// one), its conversations kept.
pub async fn disconnect(st: &State, user: &str, id: i32) -> anyhow::Result<()> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT connector, account FROM db_pigeon_connections WHERE id = $1 AND user_id = $2").bind(id).bind(user).fetch_optional(&st.pool).await?;
    let (connector, account) = row.ok_or_else(|| anyhow::anyhow!("no such connection"))?;
    if let Some(c) = connectors::find(st, &connector) {
        c.disconnect(st, user, &account).await?;
    }
    sqlx::query("UPDATE db_pigeon_connections SET status = 'disconnected', secret = NULL, cursor = NULL, updated_at = NOW() WHERE id = $1")
        .bind(id)
        .execute(&st.pool)
        .await?;
    crate::apps::pigeon::events::publish(&st.pool, user, "connections", None).await;
    Ok(())
}
