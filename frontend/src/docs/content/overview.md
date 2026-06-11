# Overview

## What's inside

- **Notes** — markdown notes with folders, tags, soft-delete trash, and vector
  embeddings for semantic search.
- **LLM chat & agents** — conversational agents with editable personas, multiple
  providers/models, streaming, and a large catalog of tools that act on your vault.
- **Agent memory** — a layered, persistent memory (L1–L4) so the agent learns your
  preferences and ongoing work across conversations, with an admin dashboard to
  curate it.
- **Tasks, calendar & agenda** — one-off and recurring (RRULE) tasks, calendar
  events with alerts, buckets and relational tags, and a consolidated agenda.
- **File storage** — S3-compatible object storage with a CDN, presigned
  uploads/downloads, bulk operations, and zip bundling.
- **Sharing** — public, optionally password-protected share links for individual
  notes and for storage folders, with view or edit access.
- **Notifications** — scheduled alerts delivered via Web Push and mobile push, plus
  loud in-app alarms.
- **Admin panel** — runtime configuration of external services, API keys, database
  backups, and account settings.
- **Mobile app** — an Expo / React Native app with offline caching, live sync, push
  notifications, and over-the-air APK updates.

## Architecture at a glance

```
                         ┌──────────────┐
   Browser / Mobile ───▶ │  Cloudflare  │  (TLS termination)
                         └──────┬───────┘
                                │ plain HTTP :80
                         ┌──────▼───────┐
                         │    Nginx     │  reverse proxy, security headers
                         └──────┬───────┘
                  ┌────────────┼─────────────┐
                  │            │             │
          ┌───────▼──────┐  ┌──▼──────────┐  │ static assets
          │ Rust backend │  │  embedding  │  │ (React build)
          │  (Actix-web) │  │   worker    │  │
          └───────┬──────┘  └──┬──────────┘
                  │            │
          ┌───────▼────────────▼───────┐    ┌──────────────┐
          │ PostgreSQL 15 + pgvector    │    │  S3-compat   │
          └─────────────────────────────┘   │ object store │
                  │                          │    + CDN      │
   external ──────┼──────────────┬──────────└──────────────┘
                  ▼              ▼               ▼
            Azure OpenAI     LLM chat         SMTP
            (embeddings)     gateway        (transactional mail)
```

## Tech stack

| Layer | Technology |
|---|---|
| Web front end | React 19, Vite 7, Ant Design 5, TanStack Query 5, Zustand, react-router 6 |
| Editors | BlockNote, Milkdown, react-markdown |
| Back end | Rust, Actix-web 4, sqlx 0.8 (compile-time-checked SQL), tokio |
| Auth | JWT (RS256) + refresh, API keys, TOTP 2FA, argon2 hashing |
| Database | PostgreSQL 15 with the pgvector extension |
| Object storage | S3-compatible store via aws-sdk-s3, fronted by a CDN |
| AI | Azure OpenAI (embeddings), multiple chat providers, a chat gateway |
| Mobile | Expo / React Native, React Navigation, EAS builds + OTA updates |
| Infra | Nginx, Docker Compose, Cloudflare |

Continue to **Getting Started** to run the stack locally, or jump to
**System Architecture** for how the back end is structured.
