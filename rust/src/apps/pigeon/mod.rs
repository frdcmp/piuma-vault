//! Pigeon: the Inbox. The user's WhatsApp, Instagram and Gmail in one place, and Pigeon, the agent
//! that sorts what comes in and answers for them where they let it. Three roles:
//!
//!   - the Inbox (`handlers`, the web and mobile apps): people, chats, cards, the user's own
//!     messages, the switches
//!   - Piuma (the vault agent) works the Inbox through `tools` on the user's word: a message to
//!     someone is always a draft; a big change waits for the user's tap (`confirm`)
//!   - Pigeon (no chat of its own): `triage` (Jev's questions) then `agent` (the responder writes
//!     the reply, the intaker tasks, events and questions), under the user's `policy` (off / ask /
//!     auto) and safeguards (`actions`), paced like a person on chats (`pace`); what it leaves for
//!     the user is `cards`, on the phone by `alerts`
//!   - what Pigeon may tell the people who write: the catalogue of tools and levels (`offer`), who
//!     holds which permission, alone or through the user's groups (`access`), what Pigeon knows
//!     right now (`facts`: the user's place, pass-ons), and the telling itself (`tell`: Jev says
//!     what's asked, the responder is given only what the chat's permission reaches, a reply that
//!     went out on its own is read back first)
//!
//! Channels are `connectors` (one folder each). The backend serves the API, the tools over MCP
//! (`mcp_server`), the OAuth callbacks and the providers' webhooks; the pigeon-worker (`worker`,
//! `bin/pigeon-worker.rs`) runs triage, Gmail's polling, the pushes, the sweeps and the health
//! checks. Both change things through Postgres and tell the apps through `events` (NOTIFY). Every
//! row carries its user.
//! Tables are `db_pigeon_*` (`db/db_init.rs`); settings `PIGEON_*` (`config`, `.env.example`).

pub mod access;
pub mod actions;
pub mod agent;
pub mod ai;
pub mod alerts;
pub mod avatars;
pub mod away;
pub mod cards;
pub mod composing;
pub mod config;
pub mod confirm;
pub mod connect;
pub mod connectors;
pub mod context;
pub mod conversations;
pub mod events;
pub mod facts;
pub mod handlers;
pub mod health;
pub mod items;
pub mod listen;
pub mod mcp_server;
pub mod media;
pub mod offer;
pub mod owner;
pub mod pace;
pub mod people;
pub mod policy;
pub mod routes;
pub mod rules;
pub mod sign;
pub mod slugs;
pub mod state;
pub mod tell;
pub mod tools;
pub mod triage;
pub mod webhooks;
pub mod worker;
