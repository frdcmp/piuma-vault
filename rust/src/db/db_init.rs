// ⚠️ NOTE FOR HUMANS AND LLM AGENTS ⚠️
// db_init is NOT a migration tool. It only CREATEs tables/indices if they don't
// already exist (create-if-not-exists) — it never ALTERs or drops anything on an
// existing database. The `TABLES` list below is the canonical description of a
// FRESH database's schema.
//
// To change an EXISTING database (add/alter/drop a column, drop/rename an index,
// backfill data, etc.), perform it MANUALLY via the Postgres connector in the
// terminal (see CLAUDE.md for the psql command).
// THEN update the `TABLES` definitions here to match, so a fresh
// DB and the schema-drift verifier stay in sync. Do not try to express a
// migration by editing db_init alone — it won't run against existing data.

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
        name: "sprites",
        sql: r#"
            CREATE TABLE sprites (
                id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                key         TEXT UNIQUE NOT NULL,
                name        TEXT NOT NULL,
                definition  JSONB NOT NULL,
                is_builtin  BOOLEAN NOT NULL DEFAULT FALSE,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
                password_enc TEXT,
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
    TableDefinition {
        name: "db_calendar_events",
        sql: r#"
            CREATE TABLE db_calendar_events (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                location TEXT,
                starts_at TIMESTAMPTZ NOT NULL,
                ends_at TIMESTAMPTZ,
                all_day BOOLEAN NOT NULL DEFAULT FALSE,
                color TEXT,
                rrule TEXT,
                alerts JSONB NOT NULL DEFAULT '[]',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_calendar_user ON db_calendar_events USING btree (user_id)",
            "CREATE INDEX IF NOT EXISTS idx_calendar_starts_at ON db_calendar_events USING btree (starts_at)",
            "CREATE INDEX IF NOT EXISTS idx_calendar_user_range ON db_calendar_events USING btree (user_id, starts_at)",
        ],
    },
    // Buckets: top-level grouping for TASKS (a task belongs to at most one
    // bucket via db_tasks.bucket_id / db_recurring_tasks.bucket_id). Created
    // before db_tasks/db_recurring_tasks because they reference this table.
    // (Tags are flat/independent of buckets — see db_tags below.)
    TableDefinition {
        name: "db_buckets",
        sql: r#"
            CREATE TABLE db_buckets (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_buckets_user_name ON db_buckets (user_id, lower(name))",
            "CREATE INDEX IF NOT EXISTS idx_buckets_user_sort ON db_buckets USING btree (user_id, sort_order)",
        ],
    },
    // Flat tag registry shared by tasks + calendar. Maps each tag name (per user)
    // to a colour. Tags are independent of buckets — buckets group tasks directly
    // (db_tasks.bucket_id), not tags.
    TableDefinition {
        name: "db_tags",
        sql: r#"
            CREATE TABLE db_tags (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON db_tags (user_id, lower(name))",
        ],
    },
    // Recurring-task templates. Created before db_tasks because db_tasks.recurrence_id
    // references this table.
    TableDefinition {
        name: "db_recurring_tasks",
        sql: r#"
            CREATE TABLE db_recurring_tasks (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                notes TEXT,
                priority SMALLINT NOT NULL DEFAULT 0,
                bucket_id UUID REFERENCES db_buckets(id) ON DELETE SET NULL,
                rrule TEXT NOT NULL,
                dtstart TIMESTAMPTZ NOT NULL,
                until TIMESTAMPTZ,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                alerts JSONB NOT NULL DEFAULT '[]',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_recurring_tasks_user ON db_recurring_tasks USING btree (user_id)",
            "CREATE INDEX IF NOT EXISTS idx_recurring_tasks_user_active ON db_recurring_tasks USING btree (user_id, active)",
        ],
    },
    TableDefinition {
        name: "db_tasks",
        sql: r#"
            CREATE TABLE db_tasks (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                notes TEXT,
                done BOOLEAN NOT NULL DEFAULT FALSE,
                completed_at TIMESTAMPTZ,
                due_at TIMESTAMPTZ,
                priority SMALLINT NOT NULL DEFAULT 0,
                -- Manual sort position: a fractional-index key (LexoRank-style,
                -- generated client-side via `fractional-indexing`). A new key can
                -- always be minted strictly between any two neighbours, so
                -- reordering touches one row. COLLATE "C" is REQUIRED: the keys
                -- assume byte/ASCII ordering, but the DB's default locale
                -- collation (e.g. en_US.utf8) sorts 'aa' before 'aA', which would
                -- silently corrupt the order.
                rank TEXT COLLATE "C",
                bucket_id UUID REFERENCES db_buckets(id) ON DELETE SET NULL,
                recurrence_id UUID REFERENCES db_recurring_tasks(id) ON DELETE CASCADE,
                occurrence_date DATE,
                alerts JSONB NOT NULL DEFAULT '[]',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (recurrence_id, occurrence_date)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_tasks_user ON db_tasks USING btree (user_id)",
            "CREATE INDEX IF NOT EXISTS idx_tasks_user_done ON db_tasks USING btree (user_id, done)",
            "CREATE INDEX IF NOT EXISTS idx_tasks_user_bucket ON db_tasks USING btree (user_id, bucket_id)",
            "CREATE INDEX IF NOT EXISTS idx_tasks_due ON db_tasks USING btree (due_at)",
            "CREATE INDEX IF NOT EXISTS idx_tasks_user_rank ON db_tasks USING btree (user_id, done, rank)",
        ],
    },
    // Tag↔entity join tables (relational tags). Created after the entity tables
    // and db_tags they reference. Migrated from the old `tags TEXT[]` columns.
    TableDefinition {
        name: "db_task_tags",
        sql: r#"
            CREATE TABLE db_task_tags (
                task_id UUID NOT NULL REFERENCES db_tasks(id) ON DELETE CASCADE,
                tag_id  UUID NOT NULL REFERENCES db_tags(id)  ON DELETE CASCADE,
                PRIMARY KEY (task_id, tag_id)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON db_task_tags (tag_id)",
        ],
    },
    TableDefinition {
        name: "db_recurring_task_tags",
        sql: r#"
            CREATE TABLE db_recurring_task_tags (
                recurring_id UUID NOT NULL REFERENCES db_recurring_tasks(id) ON DELETE CASCADE,
                tag_id       UUID NOT NULL REFERENCES db_tags(id)            ON DELETE CASCADE,
                PRIMARY KEY (recurring_id, tag_id)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_recurring_task_tags_tag ON db_recurring_task_tags (tag_id)",
        ],
    },
    TableDefinition {
        name: "db_event_tags",
        sql: r#"
            CREATE TABLE db_event_tags (
                event_id UUID NOT NULL REFERENCES db_calendar_events(id) ON DELETE CASCADE,
                tag_id   UUID NOT NULL REFERENCES db_tags(id)            ON DELETE CASCADE,
                PRIMARY KEY (event_id, tag_id)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_event_tags_tag ON db_event_tags (tag_id)",
        ],
    },
    // Materialized alert schedule. The notification-worker polls this table for
    // due rows (fire_at <= now AND sent_at IS NULL) with FOR UPDATE SKIP LOCKED,
    // mirroring the embedding_jobs pattern. Rows are (re)built by reschedule_source
    // whenever an event/task/recurring template changes, and topped up for
    // recurring sources by the worker's rolling-window refill.
    TableDefinition {
        name: "db_scheduled_notifications",
        sql: r#"
            CREATE TABLE db_scheduled_notifications (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_id UUID NOT NULL,
                occurrence_date DATE,
                fire_at TIMESTAMPTZ NOT NULL,
                offset_minutes INTEGER NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                channels TEXT[] NOT NULL DEFAULT '{web,push}',
                sent_at TIMESTAMPTZ,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (source_type, source_id, occurrence_date, offset_minutes)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_sched_notif_due ON db_scheduled_notifications USING btree (fire_at) WHERE sent_at IS NULL",
            "CREATE INDEX IF NOT EXISTS idx_sched_notif_source ON db_scheduled_notifications USING btree (source_type, source_id)",
            "CREATE INDEX IF NOT EXISTS idx_sched_notif_user ON db_scheduled_notifications USING btree (user_id)",
        ],
    },
    // Browser Web Push subscriptions (one row per browser profile).
    TableDefinition {
        name: "db_push_subscriptions",
        sql: r#"
            CREATE TABLE db_push_subscriptions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_agent TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_push_subs_user ON db_push_subscriptions USING btree (user_id)",
        ],
    },
    // Expo push tokens (one row per device).
    TableDefinition {
        name: "db_expo_push_tokens",
        sql: r#"
            CREATE TABLE db_expo_push_tokens (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                token TEXT NOT NULL UNIQUE,
                platform TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_expo_tokens_user ON db_expo_push_tokens USING btree (user_id)",
        ],
    },
    // Per-user channel preferences (replaces the previously-mocked Profile toggles).
    TableDefinition {
        name: "db_notification_prefs",
        sql: r#"
            CREATE TABLE db_notification_prefs (
                user_id TEXT PRIMARY KEY,
                web_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    // ── Agents system (apps/agents) — multi-provider LLM chat ──────────────
    // Editable per-agent prose (the agent *kind* itself lives in registry code).
    TableDefinition {
        name: "db_agent_profiles",
        sql: r#"
            CREATE TABLE db_agent_profiles (
                agent TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                instructions TEXT NOT NULL DEFAULT '',
                user_context TEXT NOT NULL DEFAULT '',
                memory TEXT NOT NULL DEFAULT '',
                commands JSONB NOT NULL DEFAULT '[]',
                dialectic_cadence INTEGER NOT NULL DEFAULT 3,
                dialectic_depth INTEGER NOT NULL DEFAULT 1,
                dialectic_model_id TEXT,
                dialectic_observe_vault BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    // One persona per agent for now (UNIQUE(agent, name) allows multi later).
    TableDefinition {
        name: "db_agent_personas",
        sql: r#"
            CREATE TABLE db_agent_personas (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                agent TEXT NOT NULL REFERENCES db_agent_profiles(agent) ON DELETE CASCADE,
                name TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                emoji TEXT,
                system_prompt TEXT NOT NULL DEFAULT '',
                allowed_tools TEXT[],
                config JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (agent, name)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_agent_personas_agent ON db_agent_personas USING btree (agent)",
        ],
    },
    // Provider configs; api_key stored plaintext, masked at the HTTP layer.
    TableDefinition {
        name: "db_llm_providers",
        sql: r#"
            CREATE TABLE db_llm_providers (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                kind TEXT NOT NULL,
                display_name TEXT NOT NULL,
                api_key TEXT NOT NULL DEFAULT '',
                base_url TEXT,
                config JSONB NOT NULL DEFAULT '{}',
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (display_name)
            )
        "#,
        indices: &[],
    },
    // Models under each provider; exactly one global default (partial unique).
    TableDefinition {
        name: "db_llm_models",
        sql: r#"
            CREATE TABLE db_llm_models (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                provider_id UUID NOT NULL REFERENCES db_llm_providers(id) ON DELETE CASCADE,
                model_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                supports_thinking BOOLEAN NOT NULL DEFAULT FALSE,
                supports_tools BOOLEAN NOT NULL DEFAULT TRUE,
                supports_vision BOOLEAN NOT NULL DEFAULT FALSE,
                context_window INTEGER,
                price_input DOUBLE PRECISION NOT NULL DEFAULT 0,
                price_output DOUBLE PRECISION NOT NULL DEFAULT 0,
                price_cached DOUBLE PRECISION NOT NULL DEFAULT 0,
                config JSONB NOT NULL DEFAULT '{}',
                is_default BOOLEAN NOT NULL DEFAULT FALSE,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (provider_id, model_id)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_llm_models_provider ON db_llm_models USING btree (provider_id)",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_models_one_default ON db_llm_models (is_default) WHERE is_default",
        ],
    },
    // Chat threads, tagged by agent.
    TableDefinition {
        name: "db_chat_conversations",
        sql: r#"
            CREATE TABLE db_chat_conversations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                agent TEXT NOT NULL,
                title TEXT,
                model_id UUID REFERENCES db_llm_models(id) ON DELETE SET NULL,
                identity TEXT NOT NULL,
                metadata JSONB NOT NULL DEFAULT '{}',
                archived_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_chat_conv_recent ON db_chat_conversations USING btree (agent, updated_at DESC)",
        ],
    },
    // Turns inside a conversation; content is normalised JSONB blocks.
    // `content_text` is the flattened plain text of the text blocks (written by
    // the chat loop); `content_tsv` is its derived FTS vector — together they
    // back L3 conversation retrieval (full-text search over chat history).
    TableDefinition {
        name: "db_chat_messages",
        sql: r#"
            CREATE TABLE db_chat_messages (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                conversation_id UUID NOT NULL REFERENCES db_chat_conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content JSONB NOT NULL DEFAULT '[]',
                content_text TEXT,
                content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(content_text, ''))) STORED,
                embedding vector(1536),
                model_used TEXT,
                provider_kind TEXT,
                tokens_input INTEGER,
                tokens_output INTEGER,
                tokens_cached INTEGER,
                stop_reason TEXT,
                metadata JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON db_chat_messages USING btree (conversation_id, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_msg_content_tsv ON db_chat_messages USING gin (content_tsv) WHERE role IN ('user', 'assistant')",
        ],
    },
    // Append-only token-usage ledger: one row per LLM/embedding call. Powers the
    // admin Token Usage analytics page (spend per model, per source, over time).
    // `kind` is the coarse bucket ('chat' | 'embedding'); `source` is the call
    // site ('chat', 'embedding:notes', 'embedding:memory', 'embedding:search',
    // 'embedding:chat'). Token counts use a uniform convention across providers:
    // `tokens_input` = full-price (uncached) input, `tokens_cached` = cache-read
    // (cheap), `tokens_cache_write` = cache-creation (Anthropic, ~1.25x).
    TableDefinition {
        name: "db_token_usage",
        sql: r#"
            CREATE TABLE db_token_usage (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                kind TEXT NOT NULL,
                source TEXT NOT NULL,
                provider_kind TEXT,
                model TEXT NOT NULL,
                tokens_input INTEGER NOT NULL DEFAULT 0,
                tokens_output INTEGER NOT NULL DEFAULT 0,
                tokens_cached INTEGER NOT NULL DEFAULT 0,
                tokens_cache_write INTEGER NOT NULL DEFAULT 0,
                conversation_id UUID REFERENCES db_chat_conversations(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_token_usage_created ON db_token_usage USING btree (created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_token_usage_model ON db_token_usage USING btree (model, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_token_usage_source ON db_token_usage USING btree (source, created_at DESC)",
        ],
    },
    // L2 semantic memory — vector-searchable facts/preferences, scoped per agent.
    TableDefinition {
        name: "db_memory_entries",
        sql: r#"
            CREATE TABLE db_memory_entries (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                agent TEXT NOT NULL REFERENCES db_agent_profiles(agent) ON DELETE CASCADE,
                content TEXT NOT NULL,
                embedding vector(1536),
                category TEXT,
                confidence TEXT NOT NULL DEFAULT 'medium',
                source TEXT NOT NULL DEFAULT 'agent_observed',
                status TEXT NOT NULL DEFAULT 'confirmed',
                source_conversation_id UUID REFERENCES db_chat_conversations(id) ON DELETE SET NULL,
                source_message_id UUID REFERENCES db_chat_messages(id) ON DELETE SET NULL,
                tags TEXT[] NOT NULL DEFAULT '{}',
                related_ids UUID[] NOT NULL DEFAULT '{}',
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                contradicts_id UUID REFERENCES db_memory_entries(id) ON DELETE SET NULL,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_memory_agent ON db_memory_entries USING btree (agent, status, is_active)",
            "CREATE INDEX IF NOT EXISTS idx_memory_category ON db_memory_entries USING btree (agent, category)",
            "CREATE INDEX IF NOT EXISTS idx_memory_embedding ON db_memory_entries USING hnsw (embedding vector_cosine_ops)",
        ],
    },
    // Embedding queue for memory entries — same pattern as `embedding_jobs`.
    TableDefinition {
        name: "db_memory_embedding_jobs",
        sql: r#"
            CREATE TABLE db_memory_embedding_jobs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                memory_entry_id UUID NOT NULL REFERENCES db_memory_entries(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                started_at TIMESTAMPTZ,
                attempts INTEGER NOT NULL DEFAULT 0
            )
        "#,
        indices: &[],
    },
    // Phase 0 observability — what the agent "knew" each turn (L1 usage + the
    // L2 entries retrieved), for the admin inspector panel.
    TableDefinition {
        name: "db_agent_turn_logs",
        sql: r#"
            CREATE TABLE db_agent_turn_logs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                conversation_id UUID NOT NULL REFERENCES db_chat_conversations(id) ON DELETE CASCADE,
                message_id UUID REFERENCES db_chat_messages(id) ON DELETE SET NULL,
                agent TEXT NOT NULL,
                retrieved JSONB NOT NULL DEFAULT '[]',
                l1_memory_chars INTEGER,
                l1_memory_pct INTEGER,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_turn_logs_conv ON db_agent_turn_logs USING btree (conversation_id, created_at)",
        ],
    },
    // Recorder → Transcriber → Summarizer sessions. The DB row is the queryable
    // index (metadata + a pointer); the full transcript lives in S3 as
    // `transcripts/{id}.jsonl` (see apps::recorder). Audio is never stored.
    TableDefinition {
        name: "db_recording_sessions",
        sql: r#"
            CREATE TABLE db_recording_sessions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'recording'
                    CHECK (status IN ('recording', 'summarising', 'done', 'failed')),
                provider TEXT NOT NULL DEFAULT 'speechmatics',
                duration_secs INTEGER NOT NULL DEFAULT 0,
                transcript_storage_key TEXT,
                word_count INTEGER NOT NULL DEFAULT 0,
                preview TEXT NOT NULL DEFAULT '',
                running_summary TEXT,
                final_note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
                error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_recording_sessions_user ON db_recording_sessions USING btree (user_id, created_at DESC)",
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
