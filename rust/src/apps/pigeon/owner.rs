//! Whose Pigeon it is: the user's name (as the prompts and the transcript call them) and their
//! timezone (dates are written in it), from their vault profile.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use crate::db::db::DbPool;

#[derive(Debug, Clone)]
pub struct Owner {
    pub name: String,
    pub tz: Tz,
}

impl Owner {
    /// Now, in their timezone.
    pub fn now(&self) -> DateTime<Tz> {
        Utc::now().with_timezone(&self.tz)
    }

    /// A UTC time in their timezone.
    pub fn local(&self, t: DateTime<Utc>) -> DateTime<Tz> {
        t.with_timezone(&self.tz)
    }
}

/// The user's first name (else their email's local part) and timezone (else UTC).
pub async fn get(pool: &DbPool, user_id: &str) -> Owner {
    let row: Option<(Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT p.first_name, p.timezone, u.email FROM db_users u LEFT JOIN db_user_profiles p ON p.user_id = u.id WHERE u.id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let (first, tz, email) = row.unwrap_or((None, None, String::new()));
    let name = first
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| email.split('@').next().filter(|n| !n.is_empty()).unwrap_or("the user").to_string());
    let tz = tz.and_then(|t| t.parse::<Tz>().ok()).unwrap_or(Tz::UTC);
    Owner { name, tz }
}
