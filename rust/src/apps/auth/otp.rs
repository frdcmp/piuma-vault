// TOTP (RFC 6238) + trusted-device support for the second auth factor.
//
// Why hand-rolled instead of pulling in `totp-rs`? Three reasons:
//   1. The whole TOTP algorithm fits in ~30 lines and pulls in zero new deps
//      besides hmac/sha1 which we already need.
//   2. Avoiding `totp-rs` keeps the dependency surface area smaller — every
//      extra crate is another supply-chain risk in an auth path.
//   3. We get full control of base32 alphabet, drift window, and digit count.
//
// What is NOT in this file:
//   - HTTP handlers (those live in handlers.rs alongside login/register).
//   - QR PNG generation (frontend renders the QR from the otpauth URI; the
//     backend never has to ship pixels).

use chrono::{Duration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, Algorithm, Header, Validation};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use super::keys;

const TOTP_STEP_SECS: u64 = 30;
const TOTP_DIGITS: u32 = 6;
const TOTP_DRIFT_STEPS: i64 = 1;       // accept code from the previous/next 30 s window
const OTP_SESSION_MINUTES: i64 = 5;
const BACKUP_CODE_COUNT: usize = 8;
const BACKUP_CODE_LEN: usize = 10;
const TRUSTED_DEVICE_DAYS: i64 = 30;

// ── base32 (RFC 4648 alphabet, no padding) ──
const B32_ALPHA: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn b32_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() * 8 + 4) / 5);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in data {
        buffer = (buffer << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((buffer >> bits) & 0b11111) as usize;
            out.push(B32_ALPHA[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((buffer << (5 - bits)) & 0b11111) as usize;
        out.push(B32_ALPHA[idx] as char);
    }
    out
}

fn b32_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim().to_ascii_uppercase().replace(' ', "");
    let s = s.trim_end_matches('=');
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    for c in s.chars() {
        let v = B32_ALPHA.iter().position(|&x| x == c as u8)? as u32;
        buffer = (buffer << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

// ── TOTP ──

pub fn generate_secret_b32() -> String {
    let mut bytes = [0u8; 20]; // 160 bits — RFC 6238 / 4226 recommended size
    OsRng.fill_bytes(&mut bytes);
    b32_encode(&bytes)
}

pub fn build_otpauth_uri(secret_b32: &str, email: &str, issuer: &str) -> String {
    // otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
    let label = format!("{}:{}", issuer, email);
    format!(
        "otpauth://totp/{}?secret={}&issuer={}&algorithm=SHA1&digits=6&period={}",
        urlencoding::encode(&label),
        secret_b32,
        urlencoding::encode(issuer),
        TOTP_STEP_SECS
    )
}

fn totp_at(secret: &[u8], counter: u64) -> u32 {
    type HmacSha1 = Hmac<Sha1>;
    let mut mac = HmacSha1::new_from_slice(secret).expect("hmac key");
    mac.update(&counter.to_be_bytes());
    let result = mac.finalize().into_bytes();
    let offset = (result[result.len() - 1] & 0x0f) as usize;
    let bin = ((result[offset] as u32 & 0x7f) << 24)
        | ((result[offset + 1] as u32) << 16)
        | ((result[offset + 2] as u32) << 8)
        | (result[offset + 3] as u32);
    bin % 10u32.pow(TOTP_DIGITS)
}

/// Compare two strings in constant time to avoid leaking which digit matched.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn verify_totp(secret_b32: &str, code: &str) -> bool {
    let code = code.trim();
    if code.len() != TOTP_DIGITS as usize || !code.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let secret = match b32_decode(secret_b32) {
        Some(s) => s,
        None => return false,
    };
    let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        Err(_) => return false,
    };
    let current = (now / TOTP_STEP_SECS) as i64;
    for delta in -TOTP_DRIFT_STEPS..=TOTP_DRIFT_STEPS {
        let counter = (current + delta) as u64;
        let candidate = format!("{:0width$}", totp_at(&secret, counter), width = TOTP_DIGITS as usize);
        if constant_time_eq(&candidate, code) {
            return true;
        }
    }
    false
}

// ── Backup codes ──
// Codes are 10-char alphanumeric strings shown to the user once during enrollment
// and stored only as argon2 hashes server-side.

const BACKUP_ALPHA: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion

pub fn generate_backup_codes() -> Vec<String> {
    (0..BACKUP_CODE_COUNT)
        .map(|_| {
            let mut buf = [0u8; BACKUP_CODE_LEN];
            OsRng.fill_bytes(&mut buf);
            let code: String = buf
                .iter()
                .map(|b| BACKUP_ALPHA[(*b as usize) % BACKUP_ALPHA.len()] as char)
                .collect();
            // Pretty format: AAAAA-BBBBB for readability when written down.
            format!("{}-{}", &code[..5], &code[5..])
        })
        .collect()
}

pub fn normalize_backup_code(code: &str) -> String {
    code.trim().to_ascii_uppercase().replace('-', "")
}

// ── OTP session JWT ──
//
// After password verification we hand the client a tiny JWT that ONLY permits
// the second-step `/auth/login/otp` call. It's short-lived and carries no
// permissions, so even if leaked it cannot be used to act as the user.

#[derive(Debug, Serialize, Deserialize)]
pub struct OtpSessionClaims {
    pub sub: String,        // user_id
    pub exp: usize,
    pub iat: usize,
    pub token_type: String, // always "otp_pending"
}

pub fn issue_otp_session(user_id: &str) -> Result<String, String> {
    let now = Utc::now();
    let claims = OtpSessionClaims {
        sub: user_id.to_string(),
        exp: (now + Duration::minutes(OTP_SESSION_MINUTES)).timestamp() as usize,
        iat: now.timestamp() as usize,
        token_type: "otp_pending".to_string(),
    };
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("JWT".to_string());
    encode(&header, &claims, keys::encoding_key())
        .map_err(|e| format!("otp session encode: {}", e))
}

pub fn verify_otp_session(token: &str) -> Result<String, &'static str> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = 5;
    let data = decode::<OtpSessionClaims>(token, keys::decoding_key(), &validation)
        .map_err(|_| "Invalid or expired session")?;
    if data.claims.token_type != "otp_pending" {
        return Err("Invalid or expired session");
    }
    Ok(data.claims.sub)
}

// ── Trusted-device tokens ──
// Format on the wire: `<id>.<secret>` where `id` is a random uuid and `secret`
// is 32 random bytes (base64url, no padding). Server stores `id` + sha256(secret).

#[derive(Debug, Clone)]
pub struct TrustedDeviceIssued {
    pub id: String,
    pub token: String,       // <id>.<secret> — give this to the client
    pub token_hash: String,  // sha256 hex — store this
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

pub fn issue_trusted_device() -> TrustedDeviceIssued {
    let id = uuid::Uuid::new_v4().to_string();
    let mut secret = [0u8; 32];
    OsRng.fill_bytes(&mut secret);
    let secret_str = b64url_encode(&secret);
    let token = format!("{}.{}", id, secret_str);
    let token_hash = sha256_hex(&token);
    let expires_at = chrono::Utc::now() + chrono::Duration::days(TRUSTED_DEVICE_DAYS);
    TrustedDeviceIssued { id, token, token_hash, expires_at }
}

pub fn hash_trusted_device(token: &str) -> String {
    sha256_hex(token)
}

pub fn parse_trusted_device_id(token: &str) -> Option<&str> {
    token.split_once('.').map(|(id, _)| id)
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    let mut s = String::with_capacity(out.len() * 2);
    for b in out {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

fn b64url_encode(bytes: &[u8]) -> String {
    // Tiny base64url encoder so we don't pull in the `base64` crate just for this.
    const A: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(A[((n >> 18) & 0x3f) as usize] as char);
        out.push(A[((n >> 12) & 0x3f) as usize] as char);
        out.push(A[((n >> 6) & 0x3f) as usize] as char);
        out.push(A[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(A[((n >> 18) & 0x3f) as usize] as char);
        out.push(A[((n >> 12) & 0x3f) as usize] as char);
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(A[((n >> 18) & 0x3f) as usize] as char);
        out.push(A[((n >> 12) & 0x3f) as usize] as char);
        out.push(A[((n >> 6) & 0x3f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_round_trip() {
        let data = b"hello world!";
        let s = b32_encode(data);
        let back = b32_decode(&s).unwrap();
        assert_eq!(back, data);
    }

    #[test]
    fn totp_rfc6238_vector() {
        // RFC 6238 test vector for SHA1, T=59 → counter=1, secret = "12345678901234567890"
        let secret = b"12345678901234567890";
        // counter for T=59 is 59/30 = 1
        let code = totp_at(secret, 1);
        // Expected value at counter 1 per RFC is 287082 (6 digits)
        assert_eq!(format!("{:06}", code), "287082");
    }

    #[test]
    fn backup_code_format() {
        let codes = generate_backup_codes();
        assert_eq!(codes.len(), BACKUP_CODE_COUNT);
        for c in &codes {
            assert_eq!(c.len(), BACKUP_CODE_LEN + 1); // 10 chars + 1 dash
            assert!(c.contains('-'));
        }
    }
}
