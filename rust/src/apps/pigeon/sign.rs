//! Pigeon's small hashing needs: the SHA-256 one-time links are kept as, their random tokens, and
//! a webhook's HMAC signature. (Secrets at rest are `apps::shares::crypto`'s.)

use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub fn sha256(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// A random token for a one-time link: 32 bytes, URL-safe.
pub fn token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Whether `header` (`sha256=<hex>`) is the HMAC-SHA256 of `body` under `secret` (compared in
/// constant time): a webhook's signature.
pub fn signature_ok(secret: &str, body: &[u8], header: Option<&str>) -> bool {
    let Some(hex_sig) = header.and_then(|h| h.trim().strip_prefix("sha256=")) else { return false };
    let Ok(sig) = hex::decode(hex_sig) else { return false };
    let Ok(mut mac) = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()) else { return false };
    Mac::update(&mut mac, body);
    mac.verify_slice(&sig).is_ok()
}
