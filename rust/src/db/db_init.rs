use sqlx;
use crate::db::db::DbPool;

#[derive(Debug)]
pub struct InitResult {
    pub tables_created: Vec<String>,
    pub tables_skipped: Vec<String>,
}

struct TableDefinition {
    name: &'static str,
    sql: &'static str,
    indices: &'static [&'static str],
}

const TABLES: &[TableDefinition] = &[
    TableDefinition {
        name: "health",
        sql: r#"
            CREATE TABLE health (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_users",
        sql: r#"
            CREATE TABLE db_users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                is_verified BOOLEAN DEFAULT FALSE,
                otp_secret TEXT,
                otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                otp_enrolled_at TIMESTAMPTZ
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_user_profiles",
        sql: r#"
            CREATE TABLE db_user_profiles (
                user_id TEXT PRIMARY KEY REFERENCES db_users(id) ON DELETE CASCADE,
                first_name TEXT,
                last_name TEXT,
                phone TEXT,
                location TEXT,
                bio TEXT,
                birth_date DATE,
                language VARCHAR(10) DEFAULT 'en',
                timezone VARCHAR(50) DEFAULT 'UTC',
                avatar_url TEXT
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_groups",
        sql: r#"
            CREATE TABLE db_groups (
                slug TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_permissions",
        sql: r#"
            CREATE TABLE db_permissions (
                slug TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_user_groups",
        sql: r#"
            CREATE TABLE db_user_groups (
                user_id TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                group_slug TEXT NOT NULL REFERENCES db_groups(slug) ON DELETE CASCADE,
                PRIMARY KEY (user_id, group_slug)
            )
        "#,
        // At most one admin user, enforced by the DB regardless of code paths.
        indices: &[
            "CREATE UNIQUE INDEX IF NOT EXISTS one_admin_only
                ON db_user_groups (group_slug) WHERE group_slug = 'admin_group'",
        ],
    },
    TableDefinition {
        name: "db_group_permissions",
        sql: r#"
            CREATE TABLE db_group_permissions (
                group_slug TEXT NOT NULL REFERENCES db_groups(slug) ON DELETE CASCADE,
                permission_slug TEXT NOT NULL REFERENCES db_permissions(slug) ON DELETE CASCADE,
                PRIMARY KEY (group_slug, permission_slug)
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_user_permissions",
        sql: r#"
            CREATE TABLE db_user_permissions (
                user_id TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                permission_slug TEXT NOT NULL REFERENCES db_permissions(slug) ON DELETE CASCADE,
                PRIMARY KEY (user_id, permission_slug)
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_registration_verifications",
        sql: r#"
            CREATE TABLE db_registration_verifications (
                id SERIAL PRIMARY KEY,
                token TEXT UNIQUE NOT NULL,
                user_id TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_password_resets",
        sql: r#"
            CREATE TABLE db_password_resets (
                id SERIAL PRIMARY KEY,
                token TEXT UNIQUE NOT NULL,
                user_id TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_otp_backup_codes",
        sql: r#"
            CREATE TABLE db_otp_backup_codes (
                user_id   TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                code_hash TEXT NOT NULL,
                used_at   TIMESTAMPTZ,
                PRIMARY KEY (user_id, code_hash)
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_trusted_devices",
        sql: r#"
            CREATE TABLE db_trusted_devices (
                id           TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                label        TEXT,
                token_hash   TEXT NOT NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at   TIMESTAMPTZ NOT NULL,
                last_used_at TIMESTAMPTZ
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_trusted_devices_user
                ON db_trusted_devices (user_id)",
        ],
    },
    TableDefinition {
        name: "notes",
        sql: r#"
            CREATE TABLE notes (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                content_tsv TSVECTOR,
                tags TEXT[] DEFAULT '{}',
                folder TEXT DEFAULT '/',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                embedding vector(1536),
                deleted_at TIMESTAMPTZ
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_notes_user ON notes USING btree (user_id)",
            "CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes USING btree (updated_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes USING btree (folder)",
            "CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes USING gin (tags)",
            "CREATE INDEX IF NOT EXISTS idx_notes_content_tsv ON notes USING gin (content_tsv)",
            "CREATE INDEX IF NOT EXISTS idx_notes_title_trgm ON notes USING gin (title gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS idx_notes_folder_trgm ON notes USING gin (folder gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS idx_notes_embedding ON notes USING hnsw (embedding vector_cosine_ops)",
            "CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes USING btree (deleted_at)",
        ],
    },
    TableDefinition {
        name: "embedding_jobs",
        sql: r#"
            CREATE TABLE embedding_jobs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                started_at TIMESTAMPTZ,
                attempts INTEGER DEFAULT 0
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "api_keys",
        sql: r#"
            CREATE TABLE api_keys (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name TEXT NOT NULL,
                key_prefix TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                permissions TEXT[] NOT NULL DEFAULT '{}',
                created_by TEXT,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                last_used_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "app_settings",
        sql: r#"
            CREATE TABLE app_settings (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "note_shares",
        sql: r#"
            CREATE TABLE note_shares (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                slug TEXT UNIQUE NOT NULL,
                access_level TEXT NOT NULL DEFAULT 'view'
                    CHECK (access_level IN ('view', 'edit')),
                password_hash TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                expires_at TIMESTAMPTZ,
                created_by TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                last_accessed_at TIMESTAMPTZ
            )
        "#,
        indices: &[],
    },
    TableDefinition {
        name: "db_folder_shares",
        sql: r#"
            CREATE TABLE db_folder_shares (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                prefix TEXT NOT NULL,
                slug TEXT UNIQUE NOT NULL,
                access_level TEXT NOT NULL DEFAULT 'view'
                    CHECK (access_level IN ('view', 'edit')),
                password_hash TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                expires_at TIMESTAMPTZ,
                max_upload_bytes BIGINT,
                created_by TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                last_accessed_at TIMESTAMPTZ
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_db_folder_shares_prefix ON db_folder_shares (prefix)",
        ],
    },
];

pub async fn init_db(pool: &DbPool) -> Result<InitResult, sqlx::Error> {
    let mut result = InitResult {
        tables_created: Vec::new(),
        tables_skipped: Vec::new(),
    };

    // ── Ensure extensions are created before tables that depend on them ──
    for ext in &[
        "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"",
        "CREATE EXTENSION IF NOT EXISTS vector",
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
    ] {
        if let Err(e) = sqlx::query(*ext).execute(pool).await {
            log::warn!("Extension setup skipped (may need superuser): {e}");
        }
    }

    for table in TABLES {
        let table_exists: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = CURRENT_SCHEMA() AND table_name = $1"
        )
        .bind(table.name)
        .fetch_one(pool)
        .await?;

        if table_exists.0 == 0 {
            sqlx::query(table.sql)
                .execute(pool)
                .await?;
            result.tables_created.push(table.name.to_string());
        } else {
            result.tables_skipped.push(table.name.to_string());
        }

        // Indices are created with `IF NOT EXISTS`, so they apply whether the
        // table was just created or already existed.
        for index in table.indices {
            sqlx::query(*index).execute(pool).await?;
        }
    }

    // Schema drift guard: confirm the live database matches what TABLES
    // describes. Toggle with DB_VERIFY_SCHEMA (default on). On mismatch this
    // returns an error, which aborts boot in main.rs.
    if schema_verification_enabled() {
        verify_schema(pool).await?;
        println!("✅ Schema verification passed");
    }

    Ok(result)
}

/// Whether the post-init schema verification runs. Defaults to enabled;
/// set `DB_VERIFY_SCHEMA` to `0`/`false`/`off`/`no` to skip it.
fn schema_verification_enabled() -> bool {
    match std::env::var("DB_VERIFY_SCHEMA") {
        Ok(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        Err(_) => true,
    }
}

/// Recreate the canonical schema (every entry in `TABLES` plus its indices) in
/// a throwaway namespace, then diff the live `public` schema against it. This
/// avoids parsing DDL ourselves — Postgres builds the reference for us. The
/// scratch schema is rolled back before returning. Returns an error listing
/// every discrepancy: missing/extra tables, columns that differ, and indices
/// that are missing or differ.
async fn verify_schema(pool: &DbPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query("DROP SCHEMA IF EXISTS schema_check CASCADE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("CREATE SCHEMA schema_check")
        .execute(&mut *tx)
        .await?;
    // Build the reference inside schema_check; `public` stays on the path so
    // extension functions (uuid_generate_v4, gen_random_uuid, …) resolve.
    sqlx::query("SET LOCAL search_path TO schema_check, public")
        .execute(&mut *tx)
        .await?;

    for table in TABLES {
        sqlx::query(table.sql).execute(&mut *tx).await?;
        for index in table.indices {
            sqlx::query(*index).execute(&mut *tx).await?;
        }
    }

    let mut problems: Vec<String> = Vec::new();

    for table in TABLES {
        let exists: (bool,) = sqlx::query_as(
            "SELECT EXISTS (
                 SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = $1
             )",
        )
        .bind(table.name)
        .fetch_one(&mut *tx)
        .await?;

        if !exists.0 {
            problems.push(format!("missing table `{}`", table.name));
            continue;
        }

        let expected_cols = fetch_columns(&mut tx, "schema_check", table.name).await?;
        let actual_cols = fetch_columns(&mut tx, "public", table.name).await?;
        diff_maps(table.name, "column", &expected_cols, &actual_cols, &mut problems);

        let expected_idx = fetch_indices(&mut tx, "schema_check", table.name).await?;
        let actual_idx = fetch_indices(&mut tx, "public", table.name).await?;
        diff_maps(table.name, "index", &expected_idx, &actual_idx, &mut problems);
    }

    // Drop the scratch schema and discard the whole transaction.
    tx.rollback().await?;

    if problems.is_empty() {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(format!(
            "schema verification failed ({} issue(s)):\n  - {}",
            problems.len(),
            problems.join("\n  - ")
        )))
    }
}

/// Map of column name → normalised "type | nullability | default" signature.
async fn fetch_columns(
    conn: &mut sqlx::PgConnection,
    schema: &str,
    table: &str,
) -> Result<std::collections::BTreeMap<String, String>, sqlx::Error> {
    let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(name, data_type, is_nullable, default)| {
            let sig = format!(
                "{} | nullable={} | default={}",
                data_type,
                is_nullable,
                normalise(default.as_deref().unwrap_or(""))
            );
            (name, sig)
        })
        .collect())
}

/// Map of index name → normalised definition.
async fn fetch_indices(
    conn: &mut sqlx::PgConnection,
    schema: &str,
    table: &str,
) -> Result<std::collections::BTreeMap<String, String>, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(name, def)| (name, normalise(&def)))
        .collect())
}

/// Strip schema qualifiers and collapse whitespace so signatures from the
/// scratch and live schemas are comparable (e.g. `nextval('schema_check.x_seq'…)`
/// vs `nextval('x_seq'…)`, or index defs that embed the schema name).
fn normalise(s: &str) -> String {
    s.replace("schema_check.", "")
        .replace("public.", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Compare an expected vs actual map and append any differences (missing,
/// extra, or changed entries) to `problems`.
fn diff_maps(
    table: &str,
    kind: &str,
    expected: &std::collections::BTreeMap<String, String>,
    actual: &std::collections::BTreeMap<String, String>,
    problems: &mut Vec<String>,
) {
    for (name, want) in expected {
        match actual.get(name) {
            None => problems.push(format!("table `{table}`: missing {kind} `{name}`")),
            Some(got) if got != want => problems.push(format!(
                "table `{table}`: {kind} `{name}` differs (expected [{want}], found [{got}])"
            )),
            Some(_) => {}
        }
    }
    for name in actual.keys() {
        if !expected.contains_key(name) {
            problems.push(format!("table `{table}`: unexpected {kind} `{name}`"));
        }
    }
}
