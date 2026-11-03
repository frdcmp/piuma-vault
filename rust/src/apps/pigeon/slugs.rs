//! Slugs: each named person's short handle, `@marco`, `@anna-rossi`, so the user can name
//! someone to Piuma the same way ("@marco tell him I'm late"). Made from the name: the first name,
//! or first and last when the first is taken, then a number; the people who matter most (a
//! relationship, a vault note, the latest talk) get the short ones first. A slug stays when the
//! name changes; the user can set one (`slug` on the contact). A column of the contact, unique per
//! user; a merge keeps the kept one's.

use uuid::Uuid;

use crate::apps::pigeon::state::State;

/// A slug's longest.
const MAX: usize = 24;

/// A name as slug words: lowercase ASCII, accents dropped. Nothing for what isn't a name (a
/// phone number, an address, a handle).
fn words(name: &str) -> Vec<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('+') || name.contains('@') {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut word = String::new();
    for c in name.to_lowercase().chars() {
        let c = match c {
            'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            word.push(c);
        } else if c.is_whitespace() || "-_.'’()/".contains(c) {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    // a name starts with a letter
    if out.first().is_none_or(|w| !w.starts_with(|c: char| c.is_ascii_alphabetic())) {
        return Vec::new();
    }
    out
}

/// The slugs to try for a name, shortest first.
pub fn candidates(name: &str) -> Vec<String> {
    let w = words(name);
    let Some(first) = w.first() else { return Vec::new() };
    let cut = |s: String| s.chars().take(MAX).collect::<String>().trim_end_matches('-').to_string();
    let mut out = vec![cut(first.clone())];
    if w.len() > 1 {
        out.push(cut(format!("{first}-{}", w[w.len() - 1])));
        out.push(cut(w.join("-")));
    }
    for n in 2..=9 {
        out.push(format!("{}{n}", cut(first.clone())));
    }
    out.dedup();
    out
}

/// A slug as the user may set it: lowercase letters, digits and dashes, starting with a letter.
pub fn valid(s: &str) -> bool {
    let s = s.trim_start_matches('@');
    !s.is_empty() && s.len() <= MAX && s.starts_with(|c: char| c.is_ascii_lowercase()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The contact's slug, given it now from its name if it has none (None: no name to make one).
pub async fn of(st: &State, contact: Uuid) -> anyhow::Result<Option<String>> {
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT user_id, slug, name FROM db_pigeon_contacts WHERE id = $1").bind(contact).fetch_optional(&st.pool).await?;
    let Some((user, slug, name)) = row else { return Ok(None) };
    if slug.is_some() {
        return Ok(slug);
    }
    let Some(name) = name else { return Ok(None) };
    for slug in candidates(&name) {
        let given = sqlx::query(
            "UPDATE db_pigeon_contacts SET slug = $2 WHERE id = $1 AND slug IS NULL
                AND NOT EXISTS (SELECT 1 FROM db_pigeon_contacts WHERE user_id = $3 AND slug = $2)",
        )
        .bind(contact)
        .bind(&slug)
        .bind(&user)
        .execute(&st.pool)
        .await;
        match given {
            Ok(r) if r.rows_affected() > 0 => return Ok(Some(slug)),
            // taken (by a concurrent one too): the next
            Ok(_) | Err(sqlx::Error::Database(_)) => {}
            Err(e) => return Err(e.into()),
        }
        // the contact got one meanwhile
        let now: Option<String> = sqlx::query_scalar("SELECT slug FROM db_pigeon_contacts WHERE id = $1").bind(contact).fetch_one(&st.pool).await?;
        if now.is_some() {
            return Ok(now);
        }
    }
    Ok(None)
}

/// The user's own slug for a contact.
pub async fn set(st: &State, user: &str, contact: Uuid, slug: &str) -> anyhow::Result<String> {
    let slug = slug.trim().trim_start_matches('@').to_lowercase();
    if !valid(&slug) {
        anyhow::bail!("a slug is lowercase letters, digits and dashes, starting with a letter, {MAX} at most: not {slug:?}");
    }
    if let Some(other) = find(st, user, &slug).await?.filter(|o| *o != contact) {
        anyhow::bail!("@{slug} is another contact's ({other})");
    }
    sqlx::query("UPDATE db_pigeon_contacts SET slug = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2")
        .bind(contact)
        .bind(user)
        .bind(&slug)
        .execute(&st.pool)
        .await?;
    Ok(slug)
}

/// Whose this slug is, among the user's contacts (with or without its @).
pub async fn find(st: &State, user: &str, slug: &str) -> anyhow::Result<Option<Uuid>> {
    Ok(sqlx::query_scalar("SELECT id FROM db_pigeon_contacts WHERE user_id = $1 AND slug = $2")
        .bind(user)
        .bind(slug.trim().trim_start_matches('@').to_lowercase())
        .fetch_optional(&st.pool)
        .await?)
}

/// Every named contact without a slug gets one, the ones that matter most first.
pub async fn backfill(st: &State) -> anyhow::Result<usize> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT c.id FROM db_pigeon_contacts c
          WHERE c.name IS NOT NULL AND c.slug IS NULL
          ORDER BY (c.relationship IS NOT NULL OR c.note_id IS NOT NULL) DESC,
                   (SELECT MAX(last_item_at) FROM db_pigeon_conversations v WHERE v.contact_id = c.id) DESC NULLS LAST",
    )
    .fetch_all(&st.pool)
    .await?;
    let mut n = 0;
    for id in ids {
        if of(st, id).await?.is_some() {
            n += 1;
        }
    }
    Ok(n)
}

/// "@slug" for a contact that has one, else what to call them.
pub async fn tag(st: &State, contact: Option<Uuid>, fallback: &str) -> String {
    match contact {
        Some(c) => match of(st, c).await {
            Ok(Some(s)) => format!("@{s}"),
            _ => fallback.to_string(),
        },
        None => fallback.to_string(),
    }
}

/// The @slugs in what the user wrote, as Piuma needs them: who each is, with their
/// conversations (the latest first). Empty when there are none.
pub async fn mentions(st: &State, user: &str, text: &str) -> anyhow::Result<String> {
    let mut out = String::new();
    let mut seen: Vec<String> = Vec::new();
    for w in text.split(|c: char| c.is_whitespace() || ",;:!?()".contains(c)) {
        let Some(slug) = w.strip_prefix('@').map(|s| s.trim_end_matches(['.', '\'']).to_lowercase()) else { continue };
        if slug.is_empty() || seen.contains(&slug) {
            continue;
        }
        seen.push(slug.clone());
        let Some(contact) = find(st, user, &slug).await? else {
            out.push_str(&format!("@{slug}: nobody has this slug (look them up with pigeon_contacts)\n"));
            continue;
        };
        let name: Option<String> = sqlx::query_scalar::<_, Option<String>>("SELECT name FROM db_pigeon_contacts WHERE id = $1").bind(contact).fetch_one(&st.pool).await?;
        let convs: Vec<(Uuid, String, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
            "SELECT id, connector, last_item_at FROM db_pigeon_conversations WHERE contact_id = $1 ORDER BY last_item_at DESC NULLS LAST LIMIT 6",
        )
        .bind(contact)
        .fetch_all(&st.pool)
        .await?;
        let convs: Vec<String> = convs.iter().map(|(id, ch, _)| format!("{ch} {id}")).collect();
        out.push_str(&format!(
            "@{slug} = {} (contact {contact}); conversations, latest first: {}\n",
            name.unwrap_or_default(),
            if convs.is_empty() { "none".to_string() } else { convs.join(", ") }
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_from_names() {
        assert_eq!(candidates("Anna Rossi")[..3], ["anna", "anna-rossi", "anna2"]);
        assert_eq!(candidates("Marco De Luca")[..3], ["marco", "marco-luca", "marco-de-luca"]);
        assert_eq!(candidates("Niccolò Pérez")[0], "niccolo");
        assert!(candidates("+393331234567").is_empty(), "a number isn't a name");
        assert!(candidates("@someone_ig").is_empty());
        assert!(candidates("someone@example.com").is_empty());
        assert!(valid("@anna-rossi") && valid("bob") && !valid("Bob") && !valid("9lives") && !valid(""));
    }
}
