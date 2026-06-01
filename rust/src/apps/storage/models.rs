use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct ApiMessage {
    pub message: String,
}

#[derive(Serialize)]
pub struct ObjectEntry {
    pub key: String,
    pub size: i64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
}

#[derive(Serialize)]
pub struct ListResponse {
    pub prefix: String,
    pub delimiter: Option<String>,
    pub folders: Vec<String>,
    pub files: Vec<ObjectEntry>,
    pub continuation_token: Option<String>,
    pub is_truncated: bool,
    /// Public CDN base for this zone (no trailing slash). Empty if no pull
    /// zone is configured. Clients can build a URL via `${cdn_base}/${key}`.
    pub cdn_base: String,
}

#[derive(Deserialize)]
pub struct ListQuery {
    /// Folder prefix to list. `""` or `/` means root.
    pub prefix: Option<String>,
    /// Group keys by this delimiter (default `/` to behave like folders).
    pub delimiter: Option<String>,
    /// Continuation token from a previous truncated response.
    pub continuation_token: Option<String>,
    /// Max items per page (default 1000, S3's max).
    pub max_keys: Option<i32>,
}

#[derive(Deserialize)]
pub struct PresignUploadRequest {
    /// Full destination key, e.g. "docs/report.pdf".
    pub key: String,
    /// Content-Type to bind into the signature; the client must PUT with the same value.
    #[serde(default)]
    pub content_type: Option<String>,
    /// Seconds the presigned URL stays valid (default 900, max 3600).
    #[serde(default)]
    pub expires_in_secs: Option<u64>,
}

#[derive(Serialize)]
pub struct PresignUploadResponse {
    /// Presigned PUT URL — the client uploads the bytes directly to Bunny.
    pub url: String,
    pub key: String,
    /// Tokenless public CDN URL (`${BUNNY_CDN_URL}/${key}`) for serving the
    /// uploaded object directly. Empty if no pull zone is configured. Only
    /// loads for prefixes excluded from the pull zone's token authentication.
    pub public_url: String,
}

#[derive(Serialize)]
pub struct DeleteResponse {
    pub deleted: Vec<String>,
    pub failed: Vec<DeleteFailure>,
}

#[derive(Serialize)]
pub struct DeleteFailure {
    pub key: String,
    pub error: String,
}

#[derive(Deserialize)]
pub struct DeleteFolderRequest {
    pub path: String,
}

#[derive(Deserialize)]
pub struct BulkDeleteRequest {
    pub keys: Vec<String>,
}

#[derive(Deserialize)]
pub struct MoveItem {
    pub from: String,
    pub to: String,
}

#[derive(Deserialize)]
pub struct BulkMoveRequest {
    pub items: Vec<MoveItem>,
}

#[derive(Serialize)]
pub struct MoveResult {
    pub from: String,
    pub to: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct BulkMoveResponse {
    pub results: Vec<MoveResult>,
}

#[derive(Deserialize)]
pub struct SignedUrlRequest {
    pub key: String,
    /// Seconds until the URL expires (default: 3600 = 1 hour).
    #[serde(default)]
    pub expires_in_secs: Option<i64>,
}

#[derive(Serialize)]
pub struct SignedUrlResponse {
    pub url: String,
    pub expires_at: i64,
}

#[derive(Deserialize)]
pub struct ZipBundleRequest {
    /// Explicit list of object keys to include. Mutually compatible with `prefix`.
    #[serde(default)]
    pub keys: Vec<String>,
    /// Optionally include every object under this prefix.
    #[serde(default)]
    pub prefix: Option<String>,
    /// Optionally include every object under each of these prefixes (used when a
    /// multi-selection spans several folders).
    #[serde(default)]
    pub prefixes: Vec<String>,
    /// Zip download filename (without extension); defaults to `bundle`.
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Serialize)]
pub struct ZipBundleResponse {
    /// Signed CDN URL for the staged archive — client downloads it directly.
    pub url: String,
    /// The archive's key under the internal `__temp/` folder.
    pub key: String,
}
