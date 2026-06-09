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
| **L3** | Conversation full-text search | `db_chat_messages` (FTS over chat history) | No — on-demand tool |
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
  "L4 output." Supports **multi-pass depth (1-3)** and **per-agent config**
  (cadence, depth, model override via `db_agent_profiles.dialectic_*` columns).

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
   - `contradicts_id`, `related_ids[]` — links between entries (populated by Stage-B NLI
     entailment/contradiction/neutral judgment on dialectic re-derivation).
  - `is_active` — soft-delete flag.
- **`db_memory_embedding_jobs`** — embedding queue. The same `embedding-worker`
  binary that embeds notes also drains this, calling Azure OpenAI
  (`text-embedding-3-large`, 1536-dim) and writing the vector back.
- **`db_chat_messages`** — **L3** + pre-embed cache. The chat transcript. Now
  stores a precomputed `embedding vector(1536)` on write so L2 retrieval skips
  the synchronous embed call. Two more columns back the full-text search:
  `content_text` (the flattened plain text of a message's text blocks, written
  by the chat loop) and `content_tsv` (a `GENERATED` tsvector derived from it).
  A partial GIN index covers user + assistant turns.
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

The user message is **pre-embedded on write** (`db_chat_messages.embedding`) so
retrieval reads the cached vector instead of calling the embedding API
synchronously. Compared by **cosine distance** (`<=>`, where distance = 1 −
similarity). A **graded floor** decides what's relevant enough to inject:

- `confirmed` facts: distance < **0.65** (similarity > 0.35).
- `pending`/derived facts: the tighter distance < **0.5** — so guesses surface
  only when strongly on-topic.

Confirmed facts are ranked above pending, top 5 are injected, and each carries a
`[provenance]` tag so the agent treats `[derived]` entries as claims to verify,
not established fact. If nothing clears the floor, nothing is injected (better
empty than noisy). Thresholds are tuned by watching the **Turn inspector**.

If any pending facts clear the floor, an additional **"Pending facts"** block
instructs the agent to casually verify them conversationally ("I've had the
impression you prefer X — is that right?") — **opportunistic ask** in the
confirmation funnel.

### L4 dialectic (step 4)

Every N assistant turns (configurable per agent, default 3), an async job:

1. Reads the last several turns and the agent's dialectic config from
   `db_agent_profiles` (cadence, depth, optional model override).
2. Runs **multi-pass** (depth 1-3): pass 1 extracts raw observations from the
   transcript; pass 2 synthesizes patterns; pass 3 connects meta-patterns.
3. Saves each insight as `source=dialectic_derived`, `status=pending`,
   `confidence=medium`, `expires_at = now + 60 days`.

Pending facts auto-inject (at the tighter floor) but are clearly low-trust. They
**graduate** to `confirmed` through three paths:

1. **Explicit confirmation** — User clicks ✓ or the agent calls `memory_confirm`.
2. **Corroboration** — the dialectic re-derives the same fact. A **Stage-B NLI**
   check (entailment/contradiction/neutral) runs on re-derivation against
   confirmed entries; `entails` means duplicate (skip), `contradicts` populates
   `contradicts_id` and deactivates the old entry, `neutral` links both via
   `related_ids`. Pending entries skip NLI and promote directly on cosine
   match (< 0.15).
3. **Opportunistic ask** — when pending facts clear the retrieval floor, the
   agent is instructed to casually verify them conversationally.

> Note: expired pending entries (>60 days, never confirmed) are automatically
> rejected by a periodic worker sweep every 10 minutes.

## L3 — conversation retrieval

L2 is lossy on purpose: it keeps *distilled* facts and throws away the rest. L3
fills that gap — it makes the **verbatim chat transcript** keyword-searchable so
the agent can recover what was actually said.

- **Write side (passive).** Every message already gets saved; L3 also stores a
  plain-text `content_text` mirror of its text blocks. Postgres derives the
  `content_tsv` FTS vector automatically. No embeddings, no LLM, no extra latency
  — just full-text indexing. Assistant prose is indexed too (the thinking and
  tool-call blocks are stripped out, so only the actual answer is searchable).
- **Read side (on-demand).** Unlike L1/L2, L3 is **never auto-injected**. The
  agent calls the `search_conversations` tool when you reference a past
  discussion ("what did we decide about X?", "remember when…"). Results are
  full-text-ranked, **aggregated to the conversation level** (best snippet +
  match count per thread), and returned with a `ts_headline` excerpt around the
  matched terms.

The admin **Conversation search (L3)** tab runs the exact same query, so you can
see what the agent would find.

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
`memory_confirm(id)`, `memory_reject(id)`, `memory_related(id)`
(graph traversal via `related_ids`).

**L1 (always-in-context):**
`context_add(text)`, `context_replace(old, new)`, `context_remove(text)`,
`context_list` — with hard caps (memory 2,200 chars, user_context 1,375) and
normalized-match dedup.

**L3 (conversation search):**
`search_conversations(query, limit?)` — full-text search over past chat history,
returned aggregated by conversation.

## Embeddings

Saving a fact embeds it inline (so it's dedup-checked and searchable
immediately); if the provider is down, the row is inserted without a vector and a
`db_memory_embedding_jobs` row is queued for the worker to backfill. Same model
and pipeline as note embeddings: Azure OpenAI `text-embedding-3-large`, 1536-dim,
HNSW cosine index.

## Implementation status (2026-06-09)

**All planned features are now implemented.** The deferred items from the
original plan have been shipped:

- ✅ **L1** — compaction tools (context_add/replace/remove/list), hard caps, normalized dedup.
- ✅ **L2** — full semantic memory: all `memory_*` tools, ingraded floor retrieval, Stage-A cosine dedup.
- ✅ **L3** — conversation FTS, `search_conversations` tool, admin search tab.
- ✅ **L4** — dialectic reasoning, multi-pass depth (1-3), per-agent config (cadence/depth/model).
- ✅ **Stage-B NLI** — entailment/contradiction/neutral judgment on dialectic re-derivation, populates `contradicts_id` and `related_ids`.
- ✅ **Confirmation funnel** — all three paths: explicit confirm, corroboration (NLI-assisted), opportunistic ask.
- ✅ **Pre-embed** — user messages embedded on write (`db_chat_messages.embedding`), retrieval reads cached vector.
- ✅ **Periodic cleanup** — expired pending entries (>60 days) auto-rejected every 10 min by the embedding-worker.
- ✅ **Memory graph** — `related_ids` populated on neutral NLI results, traversable via `memory_related(id)`.
- ✅ **Cross-conversation patterns** — hourly category-count aggregation across agents by the embedding-worker.
- ✅ **Phase-0 turn logging** + `/admin/memory` dashboard with Turn inspector.

Nothing is deferred; the implementation matches the plan.
