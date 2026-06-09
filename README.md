<div align="center">
  <img src="frontend/src/img/piuma-icon.png" width="96" alt="Piuma Vault Logo" />
  
  # Piuma Vault

  ### A Personal Second-Brain, Agentic LLM Workspace & Media Vault
  
  *The personal playground of Piuma Vault — accessible at [vault.example.com](https://vault.example.com)*

  [![License: MIT](https://img.shields.io/badge/License-MIT-f7c948.svg?style=flat-square)](LICENSE)
  [![Stack: Rust](https://img.shields.io/badge/Backend-Rust_1.75+-3a4150.svg?logo=rust&style=flat-square)](https://www.rust-lang.org/)
  [![Stack: React](https://img.shields.io/badge/Frontend-React_19_/_Vite_7-6ab0ff.svg?logo=react&style=flat-square)](https://react.dev/)
  [![Stack: Postgres](https://img.shields.io/badge/Database-Postgres_15_/_pgvector-5cd0a9.svg?logo=postgresql&style=flat-square)](https://github.com/pgvector/pgvector)
  [![Stack: Nginx](https://img.shields.io/badge/Proxy-Nginx-232323.svg?logo=nginx&style=flat-square)](https://nginx.org/)
</div>

---

**Piuma Vault** is a secure, personal digital ecosystem combining rich notes, multi-provider LLM chat interfaces, private file/media storage, public share links, and calendar/task scheduling, plus a companion Expo mobile app. It runs on a lightweight, secure stack utilizing a highly concurrent Rust API backend, a reactive web interface, and semantic vector search.

---

## 🛠️ The Tech Stack

| Layer | Technologies & Libraries |
| :--- | :--- |
| **Frontend Web** | React 19, Vite 7, Ant Design 5, `@ant-design/x`, TanStack Query 5, Zustand, Three.js, Milkdown |
| **Backend API** | Rust, Actix-web 4, SQLx 0.8 (compile-time checked, no ORM), Tokio, Lettre, Moka Cache |
| **Database** | PostgreSQL 15 + `pgvector` (HNSW indices) |
| **Proxy / Edge** | Nginx reverse-proxy (edge route mapping & security layers), Cloudflare (TLS termination) |
| **Mobile App** | Expo / React Native, AsyncStorage, React Navigation, TanStack Query |
| **Orchestration**| Docker Compose (modular `server-stack` & `db-stack` profiles) |

---

## 🏛️ System Architecture

This flowchart outlines how request routing, data management, and background vector processing operate in the vault ecosystem:

```mermaid
flowchart TD
    CF([Cloudflare <br/> TLS Edge]) -->|HTTPS| Nginx[nginx <br/> Reverse Proxy]
    
    Nginx -->|Serves Static Assets| FE[frontend <br/> React 19 / Vite 7 SPA]
    Nginx -->|Proxies /api/v1/ to :8080| BE[backend <br/> Rust / Actix-web API]
    
    BE -->|Raw SQL Queries| DB[(postgres <br/> + pgvector)]
    
    %% The worker polls database jobs
    Worker[embedding-worker <br/> Background Queue] -->|Polls db_memory_embedding_jobs| DB
    Worker -.->|Generates 1536-Dim Vectors| AO[Azure OpenAI <br/> text-embedding-3-large]

    %% Styles and Classes for gorgeous, readable theme integration
    classDef store fill:#1b1e25,stroke:#3a4150,stroke-width:2px;
    class DB store;
```

- **`backend`** (`rust/src/main.rs`) — High-throughput Actix-web server hosting the primary vault API. Routes are registered relatively (e.g. `/admin/notes`) while Nginx prepends the `/api/v1/` edge namespace. Secures entrypoints with JWTs (RS256 keys) or explicit API Keys, implementing granular permissions and multi-factor authentication (TOTP/2FA).
- **`embedding-worker`** (`rust/src/bin/embedding-worker.rs`) — An offline background service that drains the `embedding_jobs` table using a robust `FOR UPDATE SKIP LOCKED` query mechanism. It submits payloads to Azure OpenAI (`text-embedding-3-large`) and saves 1536-dimensional vectors for semantic note recall and memory lookup.
- **Zero-Migration Bootstrap** — Database initialization runs strictly on boot, dynamically mapping the schema using high-performance, create-if-not-exists `TABLES` statements managed by the rust executable.

---

## 🧠 Agent Memory System

The AI agent possesses a layered, persistent memory architecture built directly on the existing PostgreSQL + `pgvector` stack, allowing it to synthesize preferences, implicit observations, and conversation threads over multiple sessions:

*   **L1 (Scratchpad):** An always-in-context, hard-capped memory panel (`db_agent_profiles.memory` & `user_context`) injected directly into every user prompt.
*   **L2 (Semantic Facts):** High-trust, vector-searchable statements recalled via cosine similarity (`<=>`) from `db_memory_entries` when relevant to active user messages.
*   **L3 (Conversational index):** A high-performance Postgres FTS (Full-Text Search) over historical messages (`content_tsv`) triggered manually by the agent.
*   **L4 (Dialectic Reasoning):** An asynchronous background process running at a customizable turn cadence to derive implicit, behavioral patterns and write them as pending entries.

### Chat to Memory Flow

This flowchart illustrates the complete lifecycle of how active chat interactions flow into the agent's memory layers and how pending insights graduate into confirmed long-term memory:

```mermaid
flowchart TD
    Chat([User & Agent Chat]) -->|context_add| L1[(L1 Scratchpad<br/>db_agent_profiles)]
    
    %% Direct Stating & Observation Paths (Left Side)
    Chat -->|Direct User Request| US[User Stated Fact]
    Chat -->|Agent Inference| AO[Agent Observed Fact]
    
    US -->|memory_save| L2C[(L2 Confirmed Facts<br/>db_memory_entries)]
    AO -->|memory_save| L2C

    %% Passive Logging & Dialectic Paths (Right Side)
    Chat -->|Passive Write| L3[(L3 Conversation Search<br/>db_chat_messages)]
    L3 -->|Every N Turns| L4[L4 Dialectic Job]
    L4 -->|Multi-Pass GPT Sweep| L4P[(L4 Pending Facts<br/>db_memory_entries)]

    %% Graduation Funnel (Clean direct routing without subgraph boundary box)
    L4P -->|Explicit UI ✓ Click| L2C
    L4P -->|Stage-B NLI Corroboration| L2C
    L4P -->|Opportunistic Ask in Chat| L2C

    %% Prompt Injection (Bottom)
    L2C -->|Distance < 0.65| Injected([Injected into Next Prompt])
    L4P -->|Distance < 0.5| Injected

    %% Styles and Classes for gorgeous, readable theme integration
    classDef store fill:#1b1e25,stroke:#3a4150,stroke-width:2px;
    classDef action fill:#15171c,stroke:#3a4150,stroke-width:2px;
    class L1,L2C,L3,L4P store;
```

---

## 🚀 Getting Started

### Prerequisites

*   **Docker** + **Docker Compose**
*   **Bun** (for the frontend node environment)
*   **Rust Toolchain** (strictly for local checks/diagnostics)

### 1. Configuration

Clone the environment template and configure your secrets, API keys, and server bindings:

```bash
cp .env.example .env
# Open .env and fill in DB, SMTP, Bunny Storage, and JWT credentials.
```

> [!NOTE]
> Azure OpenAI embeddings configurations and individual LLM Provider API routes (DeepSeek, Anthropic, Gemini, OpenAI) are managed directly inside the Database and configured dynamically at runtime in the admin **Services** and **Agents** dashboards, not via static environment variables.

*JWT signature keypairs (RS256) are generated automatically into `rust/src/keys/` during the bootstrap build. For remote hosting, you can override them via `JWT_PRIVATE_KEY_PEM` & `JWT_PUBLIC_KEY_PEM` variables.*

### 2. Execution

You can run the stack natively using standard Compose targets:

```bash
# Start the full stack (production-ready reverse proxy, backend worker, postgres db)
docker compose --profile server-stack --profile db-stack up -d

# Start backend container watch only (rust recompiles inside container via cargo watch)
docker compose --profile server-stack up

# Run frontend development workspace locally (proxies backend calls to nginx edge)
cd frontend
bun install
bun run dev

# Follow container runtime logs
docker compose logs -f rust
```

By default (`NGINX_PORT=8034`), the unified backend API health diagnostics can be queried at: `http://localhost:8034/api/v1/health`

---

## 🧪 Local Development

Perform direct verification and optimization tasks without invoking container builds:

```bash
# Backend — Check for syntax, types, and schema compliance without triggering a build
cd rust
cargo check

# Frontend — Run Biome quality sweeps, formats, and build bundle validation
cd frontend
bun run dev          # Start local Vite workspace (Vite 7)
bun run build        # Validate output bundles and compression outputs (gzip + brotli)
bun run lint         # Check Biome code warnings/rules
bun run format       # Re-format code to spec
```

> [!IMPORTANT]
> Backend timezone metrics are processed exclusively in UTC. Always route timezone conversions through the client-side module: `frontend/src/utils/dateTime.js`.

---

##  Repository Layout

```
├── frontend/    # React 19 SPA + Vite web dashboard (Milkdown editor, Ant Design, CSS Grid)
├── rust/        # High-performance Actix-web server (binaries: backend API & offline embedding-worker)
├── mobile/      # Expo & React Native companion app for phone triggers (persisted queries, async stores)
├── nginx/       # Nginx server configuration (reverse-proxy bindings, TLS configs, and client IP mappings)
├── md/          # Systems documentation, features roadmap, and markdown resumes
└── CLAUDE.md    # Codebase styleguide, rules, conventions, and fast commands index
```

---

*Made with 💛 by [Piuma Vault](https://github.com/pv)*
