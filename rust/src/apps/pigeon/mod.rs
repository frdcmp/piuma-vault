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
//!
//! Channels are `connectors` (one folder each). The backend serves the API, the OAuth callbacks
//! and the providers' webhooks; the pigeon-worker (`worker`, `bin/pigeon-worker.rs`) runs triage,
//! Gmail's polling, the pushes, the sweeps, the summary and the health checks. Both change things
//! through Postgres and tell the apps through `events` (NOTIFY). Every row carries its user.
//! Tables are `db_pigeon_*` (`db/db_init.rs`); settings `PIGEON_*` (`config`, `.env.example`).

pub mod actions;
pub mod agent;
pub mod ai;
pub mod alerts;
pub mod avatars;
pub mod cards;
pub mod composing;
pub mod config;
pub mod confirm;
pub mod connect;
pub mod connectors;
pub mod context;
pub mod conversations;
pub mod events;
pub mod handlers;
pub mod health;
pub mod items;
pub mod media;
pub mod owner;
pub mod pace;
pub mod people;
pub mod policy;
pub mod routes;
pub mod rules;
pub mod sign;
pub mod slugs;
pub mod state;
pub mod summary;
pub mod tools;
pub mod triage;
pub mod webhooks;
pub mod worker;
