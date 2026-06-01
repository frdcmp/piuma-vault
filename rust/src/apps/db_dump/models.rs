use serde::{Deserialize, Serialize};

/// One backup file stored under the S3 `dump/` prefix.
#[derive(Debug, Serialize)]
pub struct DumpInfo {
    pub key: String,
    pub filename: String,
    pub size: i64,
    /// RFC3339 UTC timestamp (browser converts via dateTime util).
    pub last_modified: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub dumps: Vec<DumpInfo>,
}

/// Result of creating a new dump.
#[derive(Debug, Serialize)]
pub struct CreateDumpResponse {
    pub key: String,
    pub filename: String,
    pub size: i64,
    pub created_at: String,
    pub tables: usize,
    pub rows: i64,
}

/// Body for actions that target an existing dump (download / restore / delete).
#[derive(Debug, Deserialize)]
pub struct KeyRequest {
    pub key: String,
}

#[derive(Debug, Serialize)]
pub struct DownloadResponse {
    pub url: String,
    pub expires_at: i64,
    pub filename: String,
}

#[derive(Debug, Serialize)]
pub struct RestoreResponse {
    pub restored: bool,
    pub tables: usize,
    pub rows: i64,
}

#[derive(Debug, Serialize)]
pub struct ApiMessage {
    pub message: String,
}
