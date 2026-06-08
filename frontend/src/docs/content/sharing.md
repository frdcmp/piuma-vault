# Sharing

Piuma Vault can publish individual notes and storage folders as public links, with
**view** or **edit** access, optional password protection, and optional expiry.
These are the `shares` and `storage_shares` apps.

## Note shares

Admins create and manage share links for a note; the public consumes them
anonymously at a public slug. A share can be view-only or grant edit access, and
can carry a password and an expiry. The public web viewer (`SharedNotePage`)
renders markdown with rich attachment rendering.

### LLM-editable shares (the edit contract)

A share granted **edit** access can be updated programmatically — this is how an
LLM (or any client) can write to a note it was handed a link to. Fetching the share
returns the note as markdown with a YAML frontmatter header; you then send the
modified document back. The update body may be one of:

1. **Markdown with YAML frontmatter** (recommended, round-trips safely):

   ```text
   ---
   title: <new title>
   tags: [tag1, tag2]
   folder: <folder or null>
   ---

   <new markdown content>
   ```

2. **JSON** — `{ "title", "content", "tags", "folder" }`; all fields optional,
   omitted fields kept as-is.
3. **Raw text body** — treated as the new content; title/tags/folder unchanged.

To round-trip safely: fetch the latest, change only what you need, then send the
whole markdown back including the frontmatter.

## Folder shares

Storage folders can be shared with the same view/edit + password + expiry model,
plus upload restrictions. Visitors can browse and download the folder, get
presigned URLs, zip its contents, and — when granted edit access — upload, create
and delete subfolders, and move or rename items. The public viewer is
`SharedFolderPage`; mobile manages shares through `FolderShareSheet`.
