use serde::{Deserialize, Serialize};

/// Service config returned to the admin dashboard. URLs are returned in plain;
/// secrets are never returned — only a `*_set` flag indicating whether a value
/// is stored.
#[derive(Debug, Serialize)]
pub struct ServiceConfigResponse {
    pub azure_embedding_url: String,
    pub azure_embedding_api_key_set: bool,
    // Generic S3 / AWS object storage. Endpoint/region/bucket/access-key-id are
    // identifiers (returned plain); the secret access key and CDN token-auth key
    // are secrets, masked behind `*_set` flags.
    pub s3_endpoint: String,
    pub s3_region: String,
    pub s3_bucket: String,
    pub s3_access_key_id: String,
    pub s3_secret_access_key_set: bool,
    pub s3_cdn_url: String,
    pub s3_cdn_token_key_set: bool,
    // Web search: the active provider (plain) + a `*_set` flag per provider key.
    pub websearch_provider: String,
    pub websearch_brave_api_key_set: bool,
    pub websearch_tavily_api_key_set: bool,
    pub websearch_serpapi_api_key_set: bool,
    pub websearch_exa_api_key_set: bool,
    // Transcription: the active provider (plain) + a `*_set` flag per provider key.
    pub transcription_provider: String,
    pub transcription_speechmatics_api_key_set: bool,
    pub transcription_assemblyai_api_key_set: bool,
    pub transcription_deepgram_api_key_set: bool,
    // GitHub: the API base (plain) + a `*_set` flag for the secret token.
    pub github_api_base: String,
    pub github_token_set: bool,
}

/// Partial update. Any omitted field is left unchanged; a secret sent as an
/// empty string clears it, a non-empty string replaces it.
#[derive(Debug, Deserialize)]
pub struct UpdateServiceConfig {
    pub azure_embedding_url: Option<String>,
    pub azure_embedding_api_key: Option<String>,
    pub s3_endpoint: Option<String>,
    pub s3_region: Option<String>,
    pub s3_bucket: Option<String>,
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key: Option<String>,
    pub s3_cdn_url: Option<String>,
    pub s3_cdn_token_key: Option<String>,
    pub websearch_provider: Option<String>,
    pub websearch_brave_api_key: Option<String>,
    pub websearch_tavily_api_key: Option<String>,
    pub websearch_serpapi_api_key: Option<String>,
    pub websearch_exa_api_key: Option<String>,
    pub transcription_provider: Option<String>,
    pub transcription_speechmatics_api_key: Option<String>,
    pub transcription_assemblyai_api_key: Option<String>,
    pub transcription_deepgram_api_key: Option<String>,
    pub github_api_base: Option<String>,
    pub github_token: Option<String>,
}

/// Screen-lock config returned to the client. The PIN itself is never returned —
/// only `pin_set` indicates whether one is stored.
#[derive(Debug, Serialize)]
pub struct ScreenLockConfig {
    pub enabled: bool,
    pub timeout_seconds: i64,
    pub pin_set: bool,
}

/// Partial screen-lock update. Omitted fields are left unchanged. A non-empty
/// `pin` (6 digits) replaces the stored hash.
#[derive(Debug, Deserialize)]
pub struct UpdateScreenLock {
    pub enabled: Option<bool>,
    pub timeout_seconds: Option<i64>,
    pub pin: Option<String>,
}

/// Unlock request — the PIN to verify against the stored hash.
#[derive(Debug, Deserialize)]
pub struct VerifyPinRequest {
    pub pin: String,
}

/// Optional GitHub overrides for a "try now" check. Blank fields fall back to
/// saved config.
#[derive(Debug, Default, Deserialize)]
pub struct TestGithubRequest {
    pub github_api_base: Option<String>,
    pub github_token: Option<String>,
}

/// Optional web-search overrides for a "try now" check. Blank fields fall back
/// to saved config.
#[derive(Debug, Default, Deserialize)]
pub struct TestWebsearchRequest {
    pub provider: Option<String>,
    pub api_key: Option<String>,
}

/// Optional transcription overrides for a "try now" check. Blank fields fall
/// back to saved config.
#[derive(Debug, Default, Deserialize)]
pub struct TestTranscriptionRequest {
    pub provider: Option<String>,
    pub api_key: Option<String>,
}

/// Optional embedding field overrides for a "try now" check, so unsaved form
/// values can be tested without persisting. Blank fields fall back to saved config.
#[derive(Debug, Default, Deserialize)]
pub struct TestEmbeddingRequest {
    pub azure_embedding_url: Option<String>,
    pub azure_embedding_api_key: Option<String>,
}

/// Optional S3 field overrides for a "try now" check, so unsaved form values can
/// be tested without persisting. Omitted/blank fields fall back to saved config.
#[derive(Debug, Default, Deserialize)]
pub struct TestStorageRequest {
    pub s3_endpoint: Option<String>,
    pub s3_region: Option<String>,
    pub s3_bucket: Option<String>,
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key: Option<String>,
    pub s3_cdn_url: Option<String>,
    pub s3_cdn_token_key: Option<String>,
}
