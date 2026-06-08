# Notes

Notes are the heart of the vault: markdown documents organized into folders, with
tags, soft-delete trash, and semantic vector search. The feature is the `notes`
app on the backend and the `/notes` vault on the web (plus the mobile VaultHome
screen).

## Organization

Notes support full CRUD with folders and tags. You can browse folder contents,
search and rename folders, and list all tags in use. The web vault presents this
as a resizable tree sidebar with tabbed editing.

## Trash (soft delete)

Deleting a note moves it to the trash rather than destroying it. From the trash you
can restore a note, delete it permanently, or empty the trash entirely. The web
exposes this through the **Trash** admin page (hooks: `useTrash`, `useRestoreNote`,
`usePermanentlyDeleteNote`, `useEmptyTrash`).

## Vector search & embeddings

Notes carry a vector embedding for semantic search, backed by pgvector with an
HNSW index. Embeddings are generated **asynchronously**:

1. Saving a note enqueues an embedding job.
2. The `embedding-worker` binary claims pending jobs, calls Azure OpenAI, writes
   the vector back onto the note, and clears the job.

Azure OpenAI credentials are configured at runtime in the **Services** dashboard,
not via env vars. See **Admin Panel**.

## Editors

The web app ships two rich editors over the same markdown:

- **BlockNote** — a block-based, Notion-like visual editor (`@blocknote/core`,
  `@blocknote/mantine`) that round-trips markdown.
- **Milkdown** — a CommonMark + GFM editor (`@milkdown/kit`) with history,
  clipboard, cursor, and a custom find-in-page highlight plugin.

Public share pages and the mobile app render markdown read-only with
`react-markdown` + `remark-gfm`, with custom renderers for embedded attachments
(images inline; video/audio/PDF/file as rich boxes).

## Live sync

The notes SSE bus emits Created/Updated/Deleted events. The web hook
`useNotesLiveUpdates` and the mobile SSE subscription keep every open device in
sync — when a note changes anywhere, other clients re-fetch.
