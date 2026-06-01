// Runtime-loaded JWT key material.
//
// The signing key MUST NOT be compiled into the binary. We resolve it once at
// first use in this order:
//
//   1. JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM   (raw PEM in env)
//   2. JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH (path to PEM file on disk)
//   3. Legacy fallback: src/keys/jwt-private.pem  (kept so local `cargo run` still works —
//      build.rs auto-generates them. Production deployments MUST set #1 or #2 and
//      should never bake the dev keys into the image.)
//
// If the lookup ultimately fails we panic at first use, which surfaces fast
// rather than letting auth silently break.

use std::fs;
use std::sync::OnceLock;
use jsonwebtoken::{DecodingKey, EncodingKey};

pub struct JwtKeys {
    pub encoding: EncodingKey,
    pub decoding: DecodingKey,
}

static KEYS: OnceLock<JwtKeys> = OnceLock::new();

fn read_pem(env_pem: &str, env_path: &str, legacy_path: &str) -> Result<Vec<u8>, String> {
    if let Ok(raw) = std::env::var(env_pem) {
        if !raw.trim().is_empty() {
            return Ok(raw.into_bytes());
        }
    }

    if let Ok(path) = std::env::var(env_path) {
        if !path.trim().is_empty() {
            return fs::read(&path).map_err(|e| format!("read {} ({}): {}", env_path, path, e));
        }
    }

    fs::read(legacy_path).map_err(|e| {
        format!(
            "no JWT key configured. Set {} or {}, or place a PEM at {}. (last error: {})",
            env_pem, env_path, legacy_path, e
        )
    })
}

fn load() -> Result<JwtKeys, String> {
    let priv_pem = read_pem(
        "JWT_PRIVATE_KEY_PEM",
        "JWT_PRIVATE_KEY_PATH",
        "src/keys/jwt-private.pem",
    )?;
    let pub_pem = read_pem(
        "JWT_PUBLIC_KEY_PEM",
        "JWT_PUBLIC_KEY_PATH",
        "src/keys/jwt-public.pem",
    )?;
    let encoding = EncodingKey::from_rsa_pem(&priv_pem)
        .map_err(|e| format!("parse JWT private key: {}", e))?;
    let decoding = DecodingKey::from_rsa_pem(&pub_pem)
        .map_err(|e| format!("parse JWT public key: {}", e))?;
    Ok(JwtKeys { encoding, decoding })
}

pub fn keys() -> &'static JwtKeys {
    KEYS.get_or_init(|| match load() {
        Ok(k) => k,
        Err(e) => panic!("JWT key initialization failed: {}", e),
    })
}

pub fn encoding_key() -> &'static EncodingKey {
    &keys().encoding
}

pub fn decoding_key() -> &'static DecodingKey {
    &keys().decoding
}
