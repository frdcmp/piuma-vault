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
    // Version history: the `trg_notes_version` BEFORE UPDATE trigger snapshots a
    // note's pre-image here whenever title/content/tags/folder change, no matter
    // which code path issued the UPDATE (HTTP handler, agent tool, share edit,
    // recorder, bulk folder rename). Rows are pruned on a tiered retention
    // schedule by the cron worker. `source` is the transaction-local
    // `app.change_source` GUC set by the write site ('user'/'agent'/'share'/…).
    TableDefinition {
        name: "note_versions",
        sql: r#"
            CREATE TABLE note_versions (
                id BIGSERIAL PRIMARY KEY,
                note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                tags TEXT[] NOT NULL DEFAULT '{}',
                folder TEXT,
                source TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_note_versions_note
                ON note_versions USING btree (note_id, created_at DESC)",
        ],
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
                -- the phone app the token is for: piuma (alarms, reports) or pigeon (the Inbox)
                app TEXT NOT NULL DEFAULT 'piuma' CHECK (app IN ('piuma', 'pigeon')),
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
    // In-app notification center / inbox. Persisted, user-facing notifications
    // with read state, surfaced in the header bell (web + mobile). Created via
    // the shared `notifications::notify()` helper, which also fans out to the
    // push channels above. `group_key` (when set) coalesces repeats of the same
    // source while still unread (count++) instead of inserting a new row.
    TableDefinition {
        name: "db_notifications",
        sql: r#"
            CREATE TABLE db_notifications (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'system',
                level TEXT NOT NULL DEFAULT 'info',
                title TEXT NOT NULL,
                body TEXT,
                action_url TEXT,
                metadata JSONB NOT NULL DEFAULT '{}',
                group_key TEXT,
                count INTEGER NOT NULL DEFAULT 1,
                read_at TIMESTAMPTZ,
                archived_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_db_notifications_user_created ON db_notifications USING btree (user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_db_notifications_unread ON db_notifications USING btree (user_id) WHERE read_at IS NULL AND archived_at IS NULL",
            "CREATE INDEX IF NOT EXISTS idx_db_notifications_group ON db_notifications USING btree (user_id, group_key) WHERE group_key IS NOT NULL AND read_at IS NULL AND archived_at IS NULL",
        ],
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
                -- Active leaf of the message tree (the currently-shown branch). The
                -- real FK to db_chat_messages(id) is added out-of-band in the DB;
                -- it's omitted here because that table is created after this one.
                active_leaf_id UUID,
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
                parent_id UUID REFERENCES db_chat_messages(id) ON DELETE CASCADE,
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
            "CREATE INDEX IF NOT EXISTS idx_chat_msg_parent ON db_chat_messages USING btree (parent_id)",
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
    // `tokens_input_audio` / `tokens_output_audio` are the audio SUBSETS of
    // input/output, for speech-to-speech models that bill audio at its own rate
    // (source 'voice'); 0 for text-only calls.
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
                tokens_input_audio INTEGER NOT NULL DEFAULT 0,
                tokens_output_audio INTEGER NOT NULL DEFAULT 0,
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
                    CHECK (status IN ('recording', 'ready', 'summarising', 'done', 'failed')),
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
    // Scheduled autonomous agent jobs. Recurrence reuses RRULE (expanded by
    // apps::agenda::recurrence) + `dtstart` for the time-of-day, exactly like
    // calendar/tasks — no cron crate. The cron-worker polls `next_run_at`.
    TableDefinition {
        name: "db_cron_jobs",
        sql: r#"
            CREATE TABLE db_cron_jobs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                prompt TEXT NOT NULL,
                agent TEXT NOT NULL DEFAULT 'vault_agent',
                conversation_id UUID REFERENCES db_chat_conversations(id) ON DELETE SET NULL,
                schedule_kind TEXT NOT NULL DEFAULT 'recurring'
                    CHECK (schedule_kind IN ('recurring', 'once')),
                rrule TEXT,
                dtstart TIMESTAMPTZ,
                run_at TIMESTAMPTZ,
                timezone TEXT NOT NULL DEFAULT 'Europe/Rome',
                next_run_at TIMESTAMPTZ,
                last_run_at TIMESTAMPTZ,
                notify BOOLEAN NOT NULL DEFAULT TRUE,
                notify_channels TEXT[] NOT NULL DEFAULT '{web,push}',
                allow_destructive BOOLEAN NOT NULL DEFAULT FALSE,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                max_runtime_secs INTEGER NOT NULL DEFAULT 180,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON db_cron_jobs USING btree (next_run_at) WHERE enabled = TRUE",
            "CREATE INDEX IF NOT EXISTS idx_cron_jobs_user ON db_cron_jobs USING btree (user_id, created_at DESC)",
        ],
    },
    // Execution history / audit for cron jobs. A 'running' row is the lock that
    // prevents a second worker (or a double-fire) from re-executing a job.
    TableDefinition {
        name: "db_cron_runs",
        sql: r#"
            CREATE TABLE db_cron_runs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                job_id UUID NOT NULL REFERENCES db_cron_jobs(id) ON DELETE CASCADE,
                started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                finished_at TIMESTAMPTZ,
                status TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'success', 'error', 'timeout', 'skipped')),
                summary TEXT,
                message_id UUID,
                tools_used JSONB NOT NULL DEFAULT '[]',
                error TEXT,
                tokens_in INTEGER,
                tokens_out INTEGER
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON db_cron_runs USING btree (job_id, started_at DESC)",
        ],
    },
    // User-managed email accounts (Services → Email). Replaces the EMAIL_* env
    // vars. Each account can independently enable SMTP send and/or IMAP read;
    // exactly one row is the system sender (partial unique on is_default).
    // Passwords are encrypted at rest (apps::shares::crypto).
    TableDefinition {
        name: "email_accounts",
        sql: r#"
            CREATE TABLE email_accounts (
                id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                label         TEXT NOT NULL,
                email_address TEXT NOT NULL,
                send_enabled  BOOLEAN NOT NULL DEFAULT false,
                smtp_host     TEXT NOT NULL DEFAULT '',
                smtp_port     INTEGER NOT NULL DEFAULT 587,
                smtp_security TEXT NOT NULL DEFAULT 'starttls',
                smtp_username TEXT NOT NULL DEFAULT '',
                smtp_password TEXT NOT NULL DEFAULT '',
                read_enabled  BOOLEAN NOT NULL DEFAULT false,
                imap_host     TEXT NOT NULL DEFAULT '',
                imap_port     INTEGER NOT NULL DEFAULT 993,
                imap_security TEXT NOT NULL DEFAULT 'ssl',
                imap_username TEXT NOT NULL DEFAULT '',
                imap_password TEXT NOT NULL DEFAULT '',
                is_default    BOOLEAN NOT NULL DEFAULT false,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_one_default ON email_accounts (is_default) WHERE is_default",
        ],
    },
    // Audit log + rate-limit source for the agent `send_email` tool. Every send
    // (incl. scheduled/cron sends) writes a row; the tool refuses once the 24h
    // count exceeds its cap.
    TableDefinition {
        name: "db_email_log",
        sql: r#"
            CREATE TABLE db_email_log (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                to_addr TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'agent',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_email_log_user_time ON db_email_log USING btree (user_id, created_at DESC)",
        ],
    },
    // Generated-image history (see apps::image_gen). The image bytes live in S3
    // under `generated/{user_id}/{id}.{ext}`; this row is the queryable index +
    // a stable CDN URL. `source` distinguishes the HTTP API from the agent tool.
    TableDefinition {
        name: "db_generated_images",
        sql: r#"
            CREATE TABLE db_generated_images (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
                prompt TEXT NOT NULL,
                revised_prompt TEXT,
                provider TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                size TEXT NOT NULL DEFAULT '1024x1024',
                storage_key TEXT NOT NULL,
                cdn_url TEXT NOT NULL,
                mime TEXT NOT NULL DEFAULT 'image/png',
                source TEXT NOT NULL DEFAULT 'api',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_gen_images_user ON db_generated_images USING btree (user_id, created_at DESC)",
        ],
    },
    // External MCP servers the agent can call (via the mcp-worker, which owns
    // all connections). `name` is the namespace in tool names
    // (`mcp__{name}__{tool}`), so it's a short slug with no `__` (the parser
    // splits on the first double underscore). Two transports: 'http'
    // (streamable HTTP; `url` + optional bearer `auth_token`) and 'stdio'
    // (`command` + `args` spawned as a child of the mcp-worker with ONLY the
    // row's `env` — admin-only, it is arbitrary code execution by design).
    // `tool_cache` holds the last tools/list result so the chat loop never
    // blocks on discovery; the worker refreshes it on connect and on
    // POST /refresh. `cron_safe` gates headless (cron) runs — chat is gated
    // per-persona (allowed_tools patterns like `mcp__github__*`) instead.
    TableDefinition {
        name: "mcp_servers",
        sql: r#"
            CREATE TABLE mcp_servers (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name TEXT UNIQUE NOT NULL,
                transport TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http', 'stdio')),
                url TEXT NOT NULL DEFAULT '',
                auth_token TEXT NOT NULL DEFAULT '',
                command TEXT NOT NULL DEFAULT '',
                args TEXT[] NOT NULL DEFAULT '{}',
                env JSONB NOT NULL DEFAULT '{}',
                enabled BOOLEAN NOT NULL DEFAULT true,
                cron_safe BOOLEAN NOT NULL DEFAULT false,
                timeout_secs INTEGER NOT NULL DEFAULT 30,
                last_status TEXT,
                last_checked_at TIMESTAMPTZ,
                tool_cache JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    // ── Pigeon (apps/pigeon): email, chats and social in one inbox ──────────
    // A connected account of a channel: the user's Gmail, WhatsApp number,
    // Instagram account. `secret` holds its tokens encrypted (apps::shares::crypto);
    // `cursor` is where its intake got to (Gmail's historyId).
    TableDefinition {
        name: "db_pigeon_connections",
        sql: r#"
            CREATE TABLE db_pigeon_connections (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                connector TEXT NOT NULL,
                account TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
                settings JSONB NOT NULL DEFAULT '{}',
                secret TEXT,
                cursor TEXT,
                last_ok_at TIMESTAMPTZ,
                last_error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (connector, account)
            )
        "#,
        indices: &["CREATE INDEX IF NOT EXISTS idx_pigeon_connections_user ON db_pigeon_connections (user_id)"],
    },
    // One-time links to connect an account (OAuth state): only the token's SHA-256.
    TableDefinition {
        name: "db_pigeon_connect_links",
        sql: r#"
            CREATE TABLE db_pigeon_connect_links (
                token_sha TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                connector TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    // A person, across channels. `note` is the user's own ("my brother, keep it
    // short") and outranks what Pigeon learns; `relationship` and `language` are
    // facts the prompts state; `slug` their @handle in the Inbox; `note_id` their
    // contact note in the vault (/contacts/<slug>/index).
    TableDefinition {
        name: "db_pigeon_contacts",
        sql: r#"
            CREATE TABLE db_pigeon_contacts (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                name TEXT,
                slug TEXT,
                note TEXT,
                relationship TEXT,
                language TEXT,
                note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
                -- their profile picture in storage (apps/pigeon/avatars.rs: the photo; beside it
                -- `.px.png`, pixelated), and when it was last looked for (NULL: never)
                avatar_key TEXT,
                avatar_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (user_id, slug)
            )
        "#,
        indices: &["CREATE INDEX IF NOT EXISTS idx_pigeon_contacts_user ON db_pigeon_contacts (user_id)"],
    },
    // How a contact is known on a channel: an email address, a phone number, an
    // Instagram id or @username.
    TableDefinition {
        name: "db_pigeon_contact_handles",
        sql: r#"
            CREATE TABLE db_pigeon_contact_handles (
                user_id TEXT NOT NULL,
                connector TEXT NOT NULL,
                handle TEXT NOT NULL,
                contact_id UUID NOT NULL REFERENCES db_pigeon_contacts(id) ON DELETE CASCADE,
                display_name TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, connector, handle)
            )
        "#,
        indices: &["CREATE INDEX IF NOT EXISTS idx_pigeon_handles_contact ON db_pigeon_contact_handles (contact_id)"],
    },
    // What Pigeon knows about a person, written by the LLM from their
    // conversations on every channel; `items` is how many it was written from.
    TableDefinition {
        name: "db_pigeon_contact_memories",
        sql: r#"
            CREATE TABLE db_pigeon_contact_memories (
                contact_id UUID PRIMARY KEY REFERENCES db_pigeon_contacts(id) ON DELETE CASCADE,
                memory TEXT NOT NULL,
                items INTEGER NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    // How the user writes to a person on one channel, from their own messages there.
    TableDefinition {
        name: "db_pigeon_contact_styles",
        sql: r#"
            CREATE TABLE db_pigeon_contact_styles (
                contact_id UUID NOT NULL REFERENCES db_pigeon_contacts(id) ON DELETE CASCADE,
                connector TEXT NOT NULL,
                profile TEXT NOT NULL,
                messages INTEGER NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (contact_id, connector)
            )
        "#,
        indices: &[],
    },
    // A thread on a channel. `attention` is what the last triage said it needs
    // (reply / action / fyi), cleared when handled; `needs_note` why it needs the
    // user when nothing else says it (the ✋ card); `triage_due_at` queues the next
    // triage (debounced); `window_until` is a channel's reply window.
    TableDefinition {
        name: "db_pigeon_conversations",
        sql: r#"
            CREATE TABLE db_pigeon_conversations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                connection_id INTEGER REFERENCES db_pigeon_connections(id) ON DELETE SET NULL,
                connector TEXT NOT NULL,
                external_id TEXT NOT NULL,
                contact_id UUID REFERENCES db_pigeon_contacts(id) ON DELETE SET NULL,
                title TEXT,
                last_in_at TIMESTAMPTZ,
                last_out_at TIMESTAMPTZ,
                last_item_at TIMESTAMPTZ,
                window_until TIMESTAMPTZ,
                triage_due_at TIMESTAMPTZ,
                attention TEXT CHECK (attention IN ('reply', 'action', 'fyi')),
                needs_note TEXT,
                importance REAL,
                kind TEXT,
                triaged_at TIMESTAMPTZ,
                handled_at TIMESTAMPTZ,
                read_at TIMESTAMPTZ,
                summary TEXT,
                summary_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (user_id, connector, external_id)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_pigeon_conversations_triage ON db_pigeon_conversations (triage_due_at) WHERE triage_due_at IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS idx_pigeon_conversations_user ON db_pigeon_conversations (user_id, last_item_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_pigeon_conversations_contact ON db_pigeon_conversations (contact_id)",
        ],
    },
    // One message, either way. author: them, me (the user, from their phone or
    // mail client, or the Inbox), pigeon (sent by an action). `raw` is the
    // channel's payload, as it came.
    TableDefinition {
        name: "db_pigeon_items",
        sql: r#"
            CREATE TABLE db_pigeon_items (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                conversation_id UUID NOT NULL REFERENCES db_pigeon_conversations(id) ON DELETE CASCADE,
                connector TEXT NOT NULL,
                external_id TEXT NOT NULL,
                direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
                author TEXT NOT NULL CHECK (author IN ('them', 'me', 'pigeon')),
                sender TEXT,
                sender_name TEXT,
                subject TEXT,
                body TEXT NOT NULL DEFAULT '',
                media JSONB NOT NULL DEFAULT '[]',
                raw JSONB,
                at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (conversation_id, external_id)
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_pigeon_items_conversation ON db_pigeon_items (conversation_id, at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_pigeon_items_search ON db_pigeon_items USING gin (to_tsvector('simple', coalesce(subject, '') || ' ' || body))",
        ],
    },
    // Jev's answers for one batch of incoming items, kept whole (`answers`) so the
    // thresholds can be re-tuned on real traffic.
    TableDefinition {
        name: "db_pigeon_triage",
        sql: r#"
            CREATE TABLE db_pigeon_triage (
                id BIGSERIAL PRIMARY KEY,
                conversation_id UUID NOT NULL REFERENCES db_pigeon_conversations(id) ON DELETE CASCADE,
                item_ids UUID[] NOT NULL DEFAULT '{}',
                model TEXT NOT NULL,
                answers JSONB NOT NULL,
                needs_reply REAL,
                actionable REAL,
                sensitive REAL,
                mood_changed REAL,
                importance REAL,
                kind TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &["CREATE INDEX IF NOT EXISTS idx_pigeon_triage_conversation ON db_pigeon_triage (conversation_id, created_at DESC)"],
    },
    // Every action, proposed or done: the log and the approval queue (the Inbox's
    // ✍ and 💡 cards). `kind` is what its policy goes by; `policy` what applied
    // (ask, auto, or direct: the user did it); `source` who proposed it.
    TableDefinition {
        name: "db_pigeon_actions",
        sql: r#"
            CREATE TABLE db_pigeon_actions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                conversation_id UUID REFERENCES db_pigeon_conversations(id) ON DELETE SET NULL,
                connector TEXT NOT NULL,
                action TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('reply', 'record', 'organize')),
                args JSONB NOT NULL DEFAULT '{}',
                status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'dropped', 'expired', 'failed')),
                source TEXT NOT NULL CHECK (source IN ('agent', 'rule', 'user', 'piuma')),
                policy TEXT NOT NULL CHECK (policy IN ('ask', 'auto', 'direct')),
                reason TEXT,
                triage_id BIGINT REFERENCES db_pigeon_triage(id) ON DELETE SET NULL,
                decided_by TEXT,
                decided_at TIMESTAMPTZ,
                result JSONB,
                error TEXT,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[
            "CREATE INDEX IF NOT EXISTS idx_pigeon_actions_pending ON db_pigeon_actions (user_id, created_at) WHERE status = 'pending'",
            "CREATE INDEX IF NOT EXISTS idx_pigeon_actions_conversation ON db_pigeon_actions (conversation_id)",
        ],
    },
    // off / ask / auto per kind of action: the user's default, then per contact,
    // then per conversation (the most specific wins). scope_id is '' for the default.
    TableDefinition {
        name: "db_pigeon_policies",
        sql: r#"
            CREATE TABLE db_pigeon_policies (
                user_id TEXT NOT NULL,
                scope TEXT NOT NULL CHECK (scope IN ('default', 'contact', 'conversation')),
                scope_id TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL CHECK (kind IN ('reply', 'record', 'organize')),
                policy TEXT NOT NULL CHECK (policy IN ('off', 'ask', 'auto')),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, scope, scope_id, kind)
            )
        "#,
        indices: &[],
    },
    // Per-user switches and markers (auto_enabled: the one switch that stops every
    // auto action; the daily summary's last run).
    TableDefinition {
        name: "db_pigeon_settings",
        sql: r#"
            CREATE TABLE db_pigeon_settings (
                user_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, key)
            )
        "#,
        indices: &[],
    },
    // The user's rules for what a sender keeps sending (a bank's alerts, receipts):
    // items on `connector` ('*': any) from `sender` (an address, or @domain) and/or
    // the person `contact_id`, with `subject_has` in the subject and the
    // `recipients` conditions met, that Jev agrees are what `expects` describes, get
    // the rule's steps instead of the agent: `record_tool` with arguments the LLM
    // fills from `record_instructions`, then `then_action` on the message.
    TableDefinition {
        name: "db_pigeon_rules",
        sql: r#"
            CREATE TABLE db_pigeon_rules (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                connector TEXT NOT NULL,
                sender TEXT,
                subject_has TEXT,
                expects TEXT NOT NULL,
                record_tool TEXT,
                record_instructions TEXT,
                then_action TEXT NOT NULL DEFAULT 'none' CHECK (then_action IN ('none', 'mark_read', 'archive', 'trash')),
                mode TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('ask', 'auto', 'paused')),
                contact_id UUID REFERENCES db_pigeon_contacts(id) ON DELETE CASCADE,
                recipients JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (user_id, name)
            )
        "#,
        indices: &[],
    },
    // A rule meeting an item: Jev's match, the steps planned, and what came of them.
    TableDefinition {
        name: "db_pigeon_rule_runs",
        sql: r#"
            CREATE TABLE db_pigeon_rule_runs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                rule_id INTEGER NOT NULL REFERENCES db_pigeon_rules(id) ON DELETE CASCADE,
                item_id UUID NOT NULL REFERENCES db_pigeon_items(id) ON DELETE CASCADE,
                conversation_id UUID NOT NULL REFERENCES db_pigeon_conversations(id) ON DELETE CASCADE,
                matched REAL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'skipped', 'dropped', 'expired')),
                reason TEXT,
                steps JSONB NOT NULL DEFAULT '[]',
                results JSONB NOT NULL DEFAULT '[]',
                error TEXT,
                decided_by TEXT,
                decided_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (rule_id, item_id)
            )
        "#,
        indices: &["CREATE INDEX IF NOT EXISTS idx_pigeon_rule_runs_pending ON db_pigeon_rule_runs (created_at) WHERE status = 'pending'"],
    },
    // A question Pigeon puts to the user (the ❓ card) because the answer is
    // theirs to give; the answer sends Pigeon back to the conversation.
    TableDefinition {
        name: "db_pigeon_questions",
        sql: r#"
            CREATE TABLE db_pigeon_questions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                conversation_id UUID NOT NULL REFERENCES db_pigeon_conversations(id) ON DELETE CASCADE,
                question TEXT NOT NULL,
                options JSONB NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired')),
                answer TEXT,
                answered_by TEXT,
                answered_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &["CREATE INDEX IF NOT EXISTS idx_pigeon_questions_open ON db_pigeon_questions (conversation_id) WHERE status = 'open'"],
    },
    // A big change asked of Piuma (replies to auto, a rule that trashes, a merge),
    // waiting for the user's tap in the Inbox before it runs.
    TableDefinition {
        name: "db_pigeon_confirmations",
        sql: r#"
            CREATE TABLE db_pigeon_confirmations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id TEXT NOT NULL,
                conversation_id UUID REFERENCES db_pigeon_conversations(id) ON DELETE CASCADE,
                tool TEXT NOT NULL,
                args JSONB NOT NULL DEFAULT '{}',
                summary TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
                result JSONB,
                decided_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    // News for the user, nothing to decide: what Pigeon did on an answer (with a
    // link), a health problem, the morning summary. In the person's chat, or
    // General when `conversation_id` is null.
    TableDefinition {
        name: "db_pigeon_news",
        sql: r#"
            CREATE TABLE db_pigeon_news (
                id BIGSERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                conversation_id UUID REFERENCES db_pigeon_conversations(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                url TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &["CREATE INDEX IF NOT EXISTS idx_pigeon_news_user ON db_pigeon_news (user_id, created_at DESC)"],
    },
    // The user said auto replies may answer again now in a conversation: the wait
    // after they wrote there themselves, and the hourly count, start from here.
    TableDefinition {
        name: "db_pigeon_auto_resumed",
        sql: r#"
            CREATE TABLE db_pigeon_auto_resumed (
                conversation_id UUID PRIMARY KEY REFERENCES db_pigeon_conversations(id) ON DELETE CASCADE,
                at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        "#,
        indices: &[],
    },
    // How loud a person is on the user's phone: a contact's, a conversation's (a
    // WhatsApp group's) or the user's default (neither); none: smart.
    TableDefinition {
        name: "db_pigeon_alert_levels",
        sql: r#"
            CREATE TABLE db_pigeon_alert_levels (
                id BIGSERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                contact_id UUID REFERENCES db_pigeon_contacts(id) ON DELETE CASCADE,
                conversation_id UUID REFERENCES db_pigeon_conversations(id) ON DELETE CASCADE,
                level TEXT NOT NULL CHECK (level IN ('all', 'smart', 'quiet', 'off')),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (contact_id IS NULL OR conversation_id IS NULL)
            )
        "#,
        indices: &[
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_pigeon_alert_levels_contact ON db_pigeon_alert_levels (contact_id) WHERE contact_id IS NOT NULL",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_pigeon_alert_levels_conversation ON db_pigeon_alert_levels (conversation_id) WHERE conversation_id IS NOT NULL",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_pigeon_alert_levels_default ON db_pigeon_alert_levels (user_id) WHERE contact_id IS NULL AND conversation_id IS NULL",
        ],
    },
    // What's wrong with Pigeon now: since when, when the user was told (a problem
    // gone is deleted, and told if it was).
    TableDefinition {
        name: "db_pigeon_health_alerts",
        sql: r#"
            CREATE TABLE db_pigeon_health_alerts (
                user_id TEXT NOT NULL,
                key TEXT NOT NULL,
                text TEXT NOT NULL,
                since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                notified_at TIMESTAMPTZ,
                PRIMARY KEY (user_id, key)
            )
        "#,
        indices: &[],
    },
];

// Trigger DDL, applied idempotently on every boot (CREATE OR REPLACE + DROP IF
// EXISTS). Triggers live here — not in TABLES — because `verify_schema` only
// diffs columns and indices; re-running these is always safe.
//
// `notes_version_snapshot` is the single chokepoint for note versioning: five
// independent modules UPDATE `notes` directly, so an application-layer hook
// would leak. It also owns two derived columns no code path maintained before:
// `updated_at` (the HTTP update handler never set it) and `embedding` (nulled
// on content change so the embedding worker re-embeds instead of keeping a
// stale vector), plus the `content_tsv` FTS vector on both insert and update.
const TRIGGER_STATEMENTS: &[&str] = &[
    // Weighted FTS vector (title > content > folder/tags) — same shape as the
    // hand-made `notes_tsvector_trigger` that lived only in the production DB
    // before versioning made the repo authoritative for triggers.
    r#"
    CREATE OR REPLACE FUNCTION notes_fts_refresh() RETURNS trigger AS $$
    BEGIN
        NEW.content_tsv :=
            setweight(to_tsvector('pg_catalog.english', coalesce(NEW.title, '')), 'A') ||
            setweight(to_tsvector('pg_catalog.english', coalesce(NEW.content, '')), 'B') ||
            setweight(to_tsvector('pg_catalog.english', coalesce(NEW.folder, '')), 'C') ||
            setweight(to_tsvector('pg_catalog.english', coalesce(array_to_string(NEW.tags, ' '), '')), 'C');
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
    "#,
    r#"
    CREATE OR REPLACE FUNCTION notes_version_snapshot() RETURNS trigger AS $$
    BEGIN
        IF (OLD.title   IS DISTINCT FROM NEW.title)
        OR (OLD.content IS DISTINCT FROM NEW.content)
        OR (OLD.tags    IS DISTINCT FROM NEW.tags)
        OR (OLD.folder  IS DISTINCT FROM NEW.folder) THEN
            INSERT INTO note_versions (note_id, user_id, title, content, tags, folder, source)
            VALUES (OLD.id, OLD.user_id, OLD.title, OLD.content,
                    coalesce(OLD.tags, '{}'), OLD.folder,
                    NULLIF(current_setting('app.change_source', true), ''));
            NEW.updated_at := NOW();
            NEW.content_tsv :=
                setweight(to_tsvector('pg_catalog.english', coalesce(NEW.title, '')), 'A') ||
                setweight(to_tsvector('pg_catalog.english', coalesce(NEW.content, '')), 'B') ||
                setweight(to_tsvector('pg_catalog.english', coalesce(NEW.folder, '')), 'C') ||
                setweight(to_tsvector('pg_catalog.english', coalesce(array_to_string(NEW.tags, ' '), '')), 'C');
            IF OLD.content IS DISTINCT FROM NEW.content THEN
                NEW.embedding := NULL;
            END IF;
        END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
    "#,
    "DROP TRIGGER IF EXISTS trg_notes_fts_insert ON notes",
    "CREATE TRIGGER trg_notes_fts_insert
        BEFORE INSERT ON notes
        FOR EACH ROW EXECUTE FUNCTION notes_fts_refresh()",
    "DROP TRIGGER IF EXISTS trg_notes_version ON notes",
    "CREATE TRIGGER trg_notes_version
        BEFORE UPDATE ON notes
        FOR EACH ROW EXECUTE FUNCTION notes_version_snapshot()",
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

    for stmt in TRIGGER_STATEMENTS {
        sqlx::query(*stmt).execute(pool).await?;
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
