//! Reversible (encrypted-at-rest) storage for share passwords.
//!
//! The argon2 `password_hash` still guards the public verify path; this is a
//! separate ciphertext, returned only to the authenticated note owner, so the
//! Share modal can always rebuild a working `?pwd=` link. The symmetric key is
//! generated once on first use and kept in `app_settings` (single-tenant).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    Key, XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};

use crate::apps::settings::store;
use crate::db::db::DbPool;

const KEY_SETTING: &str = "share_pwd_enc_key";
const NONCE_LEN: usize = 24;

/// Load the 32-byte key, generating and persisting one on first use.
async fn load_key(pool: &DbPool) -> Result<[u8; 32], String> {
    if let Some(b64) = store::get(pool, KEY_SETTING).await {
        let bytes = B64
            .decode(b64.as_bytes())
            .map_err(|e| format!("decode share key: {e}"))?;
        return bytes
            .as_slice()
            .try_into()
            .map_err(|_| "share key has wrong length".to_string());
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    store::set(pool, KEY_SETTING, &B64.encode(key))
        .await
        .map_err(|e| format!("persist share key: {e}"))?;
    Ok(key)
}

/// Encrypt a share password → base64(nonce(24) || ciphertext).
pub async fn encrypt(pool: &DbPool, plaintext: &str) -> Result<String, String> {
    let key = load_key(pool).await?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|e| format!("encrypt share password: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(out))
}

/// Decrypt a stored share password. Returns `None` on any error (corrupt data,
/// rotated key, etc.) so callers can degrade gracefully.
pub async fn decrypt(pool: &DbPool, enc: &str) -> Option<String> {
    let key = load_key(pool).await.ok()?;
    let raw = B64.decode(enc.as_bytes()).ok()?;
    if raw.len() <= NONCE_LEN {
        return None;
    }
    let (nonce, ciphertext) = raw.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let plaintext = cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .ok()?;
    String::from_utf8(plaintext).ok()
}
