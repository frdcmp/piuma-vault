use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use rsa::{pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding}, RsaPrivateKey};
use rand::rngs::OsRng;
use base64::Engine as _;
use p256::SecretKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;

/// VAPID `sub` contact seeded when no subject file exists yet: the canonical
/// site URL (`SITE_URL`), falling back to a generic placeholder. An `https://`
/// URL is a valid VAPID subject; edit `vapid_subject.txt` to a `mailto:` if you
/// prefer a contact email.
fn default_vapid_subject() -> String {
    env::var("SITE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://example.com".to_string())
}

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let keys_dir = Path::new(&manifest_dir).join("src").join("keys");
    let priv_key_path = keys_dir.join("jwt-private.pem");
    let pub_key_path = keys_dir.join("jwt-public.pem");

    // Tell Cargo to re-run this script only if these paths change
    // Not necessarily needed if we just want it to run when files are missing
    println!("cargo:rerun-if-changed=build.rs");

    if !priv_key_path.exists() || !pub_key_path.exists() {
        println!("cargo:warning=JWT keys not found, generating new RSA key pair...");

        fs::create_dir_all(&keys_dir).unwrap();

        let mut rng = OsRng;
        let bits = 2048;
        let private_key = RsaPrivateKey::new(&mut rng, bits).expect("failed to generate a key");

        let private_pem = private_key.to_pkcs8_pem(LineEnding::LF).expect("failed to encode private key");
        fs::write(&priv_key_path, private_pem.as_bytes()).expect("failed to write private key");

        let public_key = private_key.to_public_key();
        let public_pem = public_key.to_public_key_pem(LineEnding::LF).expect("failed to encode public key");
        fs::write(&pub_key_path, public_pem.as_bytes()).expect("failed to write public key");

        println!("cargo:warning=Successfully generated new JWT keys in src/keys/");
    } else {
        println!("cargo:rerun-if-changed={}", priv_key_path.display());
        println!("cargo:rerun-if-changed={}", pub_key_path.display());
    }

    ensure_vapid_keys(&keys_dir);
}

/// Make Web Push work out of the box. Mirrors the JWT auto-gen above:
///   - fresh machine (no private key) → mint a new EC P-256 pair + seed the subject
///   - existing deploy (private key present, e.g. prod) → only derive the public
///     key file from it, so existing browser subscriptions keep working
fn ensure_vapid_keys(keys_dir: &Path) {
    let private_path = keys_dir.join("vapid_private.pem");
    let public_path = keys_dir.join("vapid_public.txt");
    let subject_path = keys_dir.join("vapid_subject.txt");

    if !private_path.exists() {
        println!("cargo:warning=VAPID keys not found, generating new EC P-256 key pair...");
        fs::create_dir_all(keys_dir).unwrap();

        let secret = SecretKey::random(&mut OsRng);
        let pem = secret
            .to_sec1_pem(LineEnding::LF)
            .expect("failed to encode VAPID private key");
        fs::write(&private_path, pem.as_bytes()).expect("failed to write VAPID private key");
        write_vapid_public(&secret, &public_path);
        println!("cargo:warning=Successfully generated new VAPID keys in src/keys/");
    } else if !public_path.exists() {
        // Private key already exists (e.g. carried over from the env-based setup) —
        // derive the public key file from it rather than minting a new pair.
        let pem = fs::read_to_string(&private_path).expect("failed to read VAPID private key");
        let secret =
            SecretKey::from_sec1_pem(&pem).expect("failed to parse existing VAPID private key");
        write_vapid_public(&secret, &public_path);
        println!("cargo:warning=Derived VAPID public key from existing private key");
    } else {
        println!("cargo:rerun-if-changed={}", private_path.display());
    }

    if !subject_path.exists() {
        fs::write(&subject_path, format!("{}\n", default_vapid_subject()))
            .expect("failed to write VAPID subject");
    }
}

/// The application server key the browser subscribes with: the uncompressed
/// public point (0x04 || X || Y), base64url without padding.
fn write_vapid_public(secret: &SecretKey, public_path: &PathBuf) {
    let point = secret.public_key().to_encoded_point(false);
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(point.as_bytes());
    fs::write(public_path, format!("{b64}\n")).expect("failed to write VAPID public key");
}
