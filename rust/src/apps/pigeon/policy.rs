//! off / ask / auto per kind of action, per user. The most specific scope wins: the conversation,
//! then the contact, then the user's default (`ask` when they set none). `auto_enabled` is the one
//! switch that turns every auto into ask at once (on unless they switched it off).

use serde_json::Value as Json;
use uuid::Uuid;

use crate::apps::pigeon::connectors::Kind;
use crate::db::db::DbPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Off,
    Ask,
    Auto,
}

impl Policy {
    pub fn as_str(self) -> &'static str {
        match self {
            Policy::Off => "off",
            Policy::Ask => "ask",
            Policy::Auto => "auto",
        }
    }

    pub fn parse(s: &str) -> Option<Policy> {
        match s {
            "off" => Some(Policy::Off),
            "ask" => Some(Policy::Ask),
            "auto" => Some(Policy::Auto),
            _ => None,
        }
    }
}

/// The user's policy for `kind` on a conversation (with its contact), before the auto switch.
pub async fn resolve(pool: &DbPool, user: &str, kind: Kind, contact: Option<Uuid>, conversation: Option<Uuid>) -> anyhow::Result<Policy> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT scope, policy FROM db_pigeon_policies
          WHERE user_id = $4 AND kind = $1 AND ((scope = 'default' AND scope_id = '')
                            OR (scope = 'contact' AND scope_id = $2)
                            OR (scope = 'conversation' AND scope_id = $3))",
    )
    .bind(kind.as_str())
    .bind(contact.map(|c| c.to_string()).unwrap_or_default())
    .bind(conversation.map(|c| c.to_string()).unwrap_or_default())
    .bind(user)
    .fetch_all(pool)
    .await?;
    let pick = |scope: &str| rows.iter().find(|(s, _)| s == scope).and_then(|(_, p)| Policy::parse(p));
    Ok(pick("conversation").or_else(|| pick("contact")).or_else(|| pick("default")).unwrap_or(Policy::Ask))
}

pub async fn auto_enabled(pool: &DbPool, user: &str) -> anyhow::Result<bool> {
    let v: Option<Json> = sqlx::query_scalar("SELECT value FROM db_pigeon_settings WHERE user_id = $1 AND key = 'auto_enabled'").bind(user).fetch_optional(pool).await?;
    Ok(v.and_then(|v| v.as_bool()).unwrap_or(true))
}

pub async fn set_auto_enabled(pool: &DbPool, user: &str, on: bool) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO db_pigeon_settings (user_id, key, value, updated_at) VALUES ($2, 'auto_enabled', $1, NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    )
    .bind(Json::Bool(on))
    .bind(user)
    .execute(pool)
    .await?;
    Ok(())
}

/// Set one; `None` removes a contact or conversation override (back to the wider scope).
pub async fn set(pool: &DbPool, user: &str, scope: &str, scope_id: &str, kind: Kind, policy: Option<Policy>) -> anyhow::Result<()> {
    match policy {
        Some(p) => {
            sqlx::query(
                "INSERT INTO db_pigeon_policies (user_id, scope, scope_id, kind, policy, updated_at) VALUES ($5, $1, $2, $3, $4, NOW())
                 ON CONFLICT (user_id, scope, scope_id, kind) DO UPDATE SET policy = EXCLUDED.policy, updated_at = NOW()",
            )
            .bind(scope)
            .bind(scope_id)
            .bind(kind.as_str())
            .bind(p.as_str())
            .bind(user)
            .execute(pool)
            .await?;
        }
        None => {
            if scope == "default" {
                anyhow::bail!("the default can't be removed, only changed");
            }
            sqlx::query("DELETE FROM db_pigeon_policies WHERE user_id = $4 AND scope = $1 AND scope_id = $2 AND kind = $3")
                .bind(scope)
                .bind(scope_id)
                .bind(kind.as_str())
                .bind(user)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

/// A contact's conversations lose their own policy of this kind (theirs applies); how many did.
pub async fn clear_conversations(pool: &DbPool, contact_id: &str, kind: Kind) -> anyhow::Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM db_pigeon_policies WHERE scope = 'conversation' AND kind = $2
           AND scope_id IN (SELECT id::text FROM db_pigeon_conversations WHERE contact_id::text = $1)",
    )
    .bind(contact_id)
    .bind(kind.as_str())
    .execute(pool)
    .await?
    .rows_affected())
}

/// Every policy row of the user's, for pigeon_policies.
pub async fn list(pool: &DbPool, user: &str) -> anyhow::Result<Vec<(String, String, String, String)>> {
    Ok(sqlx::query_as("SELECT scope, scope_id, kind, policy FROM db_pigeon_policies WHERE user_id = $1 ORDER BY scope, scope_id, kind")
        .bind(user)
        .fetch_all(pool)
        .await?)
}
