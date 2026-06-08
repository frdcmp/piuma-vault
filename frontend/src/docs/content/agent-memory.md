# Agent Memory System

The vault agent has a layered, persistent memory so it can get to know User
across conversations — preferences, patterns, ongoing work — instead of starting
cold every chat. It's built entirely on the existing stack (PostgreSQL +
pgvector + Azure OpenAI embeddings); no extra services.

There are four conceptual layers. **They are a logical model, not four tables** —
in fact L2 and L4 share a single table (see below).

## The four layers at a glance

| Layer | What it is | Where it lives | Auto-injected each turn? |
|-------|------------|----------------|--------------------------|
| **L1** | Always-in-context scratchpad | `db_agent_profiles.memory` / `.user_context` (text columns) | Yes — always in the prompt |
| **L2** | Semantic long-term memory (vector-searchable facts) | `db_memory_entries` rows | Yes — top-K by relevance |
| **L3** | Conversation full-text search | *(designed, not built)* | No — on-demand tool |
| **L4** | Dialectic reasoning (auto-derived insights) | writes rows into `db_memory_entries` | Indirectly — via L2 |

## L2 vs L4 — the key distinction

**This is the most common point of confusion: L2 and L4 are not separate
stores.** They are the same table, `db_memory_entries`. The difference is
*logical*, expressed through two columns:

- **L2** is the store itself — discrete facts the agent can recall by semantic
  similarity. A fact is "L2" when its `status = 'confirmed'`.
- **L4** is a *process*, not a place. The dialectic pass runs in the background
  and **writes new rows into the same `db_memory_entries` table**, tagged
  `source = 'dialectic_derived'` and `status = 'pending'`. Those pending rows are
  "L4 output."

So a row is "L4" while it's a pending guess, and effectively becomes "L2" once
it's confirmed (`status` flips to `confirmed`). Same table, different lifecycle
stage. The admin Memory page shows them together in the **Entries (L2 / L4)** tab
and just filters by status.

## Tables

- **`db_agent_profiles`** — one row per agent. `memory` and `user_context` are
  the **L1** text fields; `instructions` is the system-prompt preamble.
- **`db_memory_entries`** — **L2 + L4**. One row per fact. Key columns:
  - `content` — the fact, one self-contained statement.
  - `embedding vector(1536)` — HNSW cosine index for semantic search.
  - `source` — `user_stated` · `agent_observed` · `dialectic_derived` · `imported`.
  - `status` — `confirmed` · `pending` · `rejected`.
  - `confidence` — `high` · `medium` · `low`.
  - `category`, `tags[]` — free-form topical labels.
  - `expires_at` — TTL (pending/derived facts expire after 60 days if never confirmed).
  - `contradicts_id`, `related_ids[]` — links between entries.
  - `is_active` — soft-delete flag.
- **`db_memory_embedding_jobs`** — embedding queue. The same `embedding-worker`
  binary that embeds notes also drains this, calling Azure OpenAI
  (`text-embedding-3-large`, 1536-dim) and writing the vector back.
- **`db_agent_turn_logs`** — observability (the **Turn inspector**): one row per
  completed turn recording which memories were retrieved (+ scores) and how full
  L1 was.

## Statuses, sources & confidence

**Status** — trust + retrieval behaviour:

- `confirmed` — trusted; retrieved into context whenever relevant.
- `pending` — low-trust (usually an L4 guess); retrieved only when *very* strongly
  relevant (a tighter floor), and auto-expires after 60 days if never confirmed.
- `rejected` — discarded; kept for the record but never retrieved.

**Source** — where the fact came from:

- `user_stated` — User said it directly / asked the agent to remember it.
  Saved as **high** confidence by default.
- `agent_observed` — the agent inferred it during a conversation (`memory_save`).
  Defaults to **medium** confidence.
- `dialectic_derived` — produced by the L4 pass. Always starts `pending`,
  `medium`.
- `imported` — bulk-loaded from elsewhere.

**Confidence** (`high`/`medium`/`low`) defaults from source when the agent
doesn't set it (`user_stated → high`, otherwise `medium`). It bumps to `high`
when a pending fact is confirmed.

## The per-turn flow

```
User sends a message
   │
   ▼
1. SYSTEM PROMPT ASSEMBLY
     • time + model blocks
     • agent instructions + persona
     • L1: db_agent_profiles.memory + user_context (always in)
     • L2: embed the message → pgvector search → inject top-K relevant
            facts, tagged with provenance ([user-stated] / [derived] …)
   │
   ▼
2. LLM TOOL LOOP (streaming)
     • the agent can call memory_save / memory_search / context_add …
   │
   ▼
3. Assistant answers → persisted
   │
   ├─ write a db_agent_turn_logs row (what was retrieved + L1 usage)
   │
   ▼
4. POST-TURN HOOK (fire-and-forget, every 3rd assistant turn)
     • L4 dialectic: summarise the last few turns with the model,
       derive implicit facts → save as pending rows in db_memory_entries
```

### L2 retrieval (step 1)

The message is embedded and compared by **cosine distance** (`<=>`, where
distance = 1 − similarity). A **graded floor** decides what's relevant enough to
inject:

- `confirmed` facts: distance < **0.65** (similarity > 0.35).
- `pending`/derived facts: the tighter distance < **0.5** — so guesses surface
  only when strongly on-topic.

Confirmed facts are ranked above pending, top 5 are injected, and each carries a
`[provenance]` tag so the agent treats `[derived]` entries as claims to verify,
not established fact. If nothing clears the floor, nothing is injected (better
empty than noisy). Thresholds are tuned by watching the **Turn inspector**.

### L4 dialectic (step 4)

Every 3 assistant turns *within a conversation*, an async job:

1. Reads the last several turns.
2. Asks the model to extract implicit facts/preferences/patterns it can infer
   (one `[category] fact` per line).
3. Saves each as `source=dialectic_derived`, `status=pending`, `confidence=medium`,
   `expires_at = now + 60 days`.

Pending facts auto-inject (at the tighter floor) but are clearly low-trust. They
**graduate** to `confirmed` when:

- User confirms one (the ✓ button, or `memory_confirm`), **or**
- the dialectic independently re-derives the same fact later (corroboration).

A re-derivation of a near-duplicate (cosine distance < 0.15) is treated as
corroboration rather than a new row.

> Note: cadence counts assistant turns *per conversation*, so very short chats
> never trigger the dialectic pass.

## L1 — why it's usually empty

L1 (`db_agent_profiles.memory`) is the handful of facts the agent wants in front
of it on *every* turn. It is **not** filled automatically — only when the agent
calls `context_add`, which it's instructed to do rarely (almost everything goes
to L2 via `memory_save`). So L1 staying near-empty is expected; the bulk of
memory lives in L2. `user_context` is the other L1 field and holds the standing
profile/preferences.

## Tools the agent uses

**L2 (semantic store):**
`memory_search(query)`, `memory_save(content, source?, category?, confidence?, tags?)`,
`memory_update(id, content)`, `memory_delete(id)`, `memory_list(category?)`,
`memory_confirm(id)`, `memory_reject(id)`.

**L1 (always-in-context):**
`context_add(text)`, `context_replace(old, new)`, `context_remove(text)`,
`context_list` — with hard caps (memory 2,200 chars, user_context 1,375) and
normalized-match dedup.

## Embeddings

Saving a fact embeds it inline (so it's dedup-checked and searchable
immediately); if the provider is down, the row is inserted without a vector and a
`db_memory_embedding_jobs` row is queued for the worker to backfill. Same model
and pipeline as note embeddings: Azure OpenAI `text-embedding-3-large`, 1536-dim,
HNSW cosine index.

## Implementation status

Built: L1 (compaction tools), L2 (full), L4 (dialectic + confirmation funnel),
Phase-0 turn logging, and the `/admin/memory` dashboard. Deferred: L3
(conversation FTS), NLI-based contradiction detection, pre-embedding the user
message on write, and per-agent dialectic config (cadence/depth/model are
currently constants).
