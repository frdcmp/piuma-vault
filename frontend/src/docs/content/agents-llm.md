# LLM Chat & Agents

The `agents` app is a multi-provider, multi-agent LLM chat system with streaming,
turn control, and a large catalog of tools that act directly on your vault.

## Agents and personas

An **agent** (e.g. a general vault agent, or the gateway agent) has an editable
profile — its instructions, user context, memory, and slash commands. Each agent
can have multiple **personas** that tune behavior and narrow the available tools.

The agent is steered to consult the **vault** (notes, tasks, calendar) rather than
the web for personal questions — e.g. calendar queries resolve against your data,
not a web search.

## Providers and models

Providers and models are configured at runtime through the admin **Agents** page —
DeepSeek, Anthropic, OpenAI, Gemini, Minimax, and a chat gateway are supported.

> Many default models are reasoning models. One-shot calls need a generous
> `max_tokens`, or the reasoning budget consumes the whole allowance and content
> comes back empty.

## Conversations

Turns stream token-by-token. A **turn control plane** supports **STOP** (cancel a
running generation) and **INJECT** (queue a message for the next turn boundary).
Conversations and their messages persist with token tracking and stop reasons;
titles can be auto-generated. Conversations can be created, listed, renamed,
cleared, and deleted.

## Tool catalog

Tools are registered on agents via a registry; a persona can narrow them further.
By domain:

- **Notes** — search, read, list/browse/search folders, list tags, create, update,
  append, delete
- **Tasks** — list/get, list recurring, create, update, toggle, create/update
  recurring, complete an occurrence, delete
- **Calendar** — list, get, create, update, delete events
- **Agenda** — consolidated upcoming view
- **Buckets** — list, create, rename, delete
- **Storage** — list, signed URL, delete object/folder, bulk move, presign upload,
  zip bundle
- **Shares** — list, create, update, delete
- **Web** — web search, web fetch
- **Self-config** — read self, update instructions / user context / memory /
  persona (scoped to the active agent)
- **Memory (L2)** — search, save, update, delete, list, confirm, reject
- **Always-in-context (L1)** — context add / replace / remove / list

## Memory

The agent has a layered, persistent memory so it learns User's preferences
and ongoing work across conversations. Relevant facts are auto-injected into the
system prompt each turn, and a background "dialectic" pass derives new ones. This
is a system in its own right — see **[Agent Memory](/docs/agent-memory)** for the
layers (L1–L4), the database tables, the per-turn flow, and how L2 vs L4 differ.

The live state is browsable in the admin **Memory** dashboard (`/admin/memory`).

## Web search

Web search is provider-agnostic, normalizing results to a common shape. Brave,
Tavily, SerpAPI (Google), and Exa are supported; the active provider is chosen in
**Services**.

## Chat gateway

An external chat gateway with its own model and tools is integrated alongside the
direct providers. History is loaded from the gateway over HTTP. Like the other
services, it is configured at runtime rather than via env vars.
