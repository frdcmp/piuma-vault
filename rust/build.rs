use std::env;
use std::fs;
use std::path::Path;
use rsa::{pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding}, RsaPrivateKey};
use rand::rngs::OsRng;

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
}
