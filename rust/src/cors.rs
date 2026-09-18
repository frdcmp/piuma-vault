//! CORS policy, configured from the environment so allowed domains can change
//! without a rebuild.
//!
//! - `CORS_ALLOWED_ORIGINS` — comma-separated list of exact origins, e.g.
//!   `"https://vault.example.com,https://www.example.com"`.
//! - `CORS_ALLOW_LOCAL` (default `true`) — additionally permit localhost/LAN
//!   origins for development. Set to `false` in production to allow only the
//!   explicit list above.

use actix_cors::Cors;

/// Parsed CORS settings, read once at startup and reused to build a fresh
/// [`Cors`] per HTTP worker.
#[derive(Clone)]
pub struct CorsConfig {
    allowed_origins: Vec<String>,
    allow_local: bool,
}

impl CorsConfig {
    /// Read the policy from the environment.
    pub fn from_env() -> Self {
        let allowed_origins = std::env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let allow_local = std::env::var("CORS_ALLOW_LOCAL")
            .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no"))
            .unwrap_or(true);

        Self { allowed_origins, allow_local }
    }

    /// Log a one-line summary of the active policy.
    pub fn log(&self) {
        println!(
            "🔒 CORS: {} explicit origin(s){}",
            self.allowed_origins.len(),
            if self.allow_local { " + localhost/LAN (dev)" } else { "" }
        );
    }

    /// Build an actix [`Cors`] middleware from this policy. Called once per
    /// worker, so the origin list is cloned into the matcher closure.
    pub fn build(&self) -> Cors {
        let allowed_origins = self.allowed_origins.clone();
        let allow_local = self.allow_local;

        Cors::default()
            .allowed_origin_fn(move |origin, _req_head| {
                let Ok(o) = origin.to_str() else { return false };
                if allow_local && is_local_origin(o) {
                    return true;
                }
                allowed_origins.iter().any(|allowed| allowed == o)
            })
            .allowed_methods(vec!["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"])
            // Origin allowlist (above) + JWT auth are the security boundary here;
            // request headers are not. Allow any header so custom client headers
            // (e.g. last-event-id) don't trip preflight 400s.
            .allow_any_header()
            .max_age(3600)
    }
}

/// Is this a loopback / RFC1918 origin we allow for local development?
///
/// Parse the host instead of prefix-matching the origin string. The previous
/// `origin.starts_with("http://10.")` form also matched `http://10.evil.com`
/// — a digit is a legal first character in a DNS label, so an attacker can
/// simply register a host that satisfies the prefix.
fn is_local_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    // Origins carry no path, but be defensive about trailing slashes.
    let authority = rest.split('/').next().unwrap_or(rest);

    // Strip the port, taking care not to split an IPv6 literal on its colons.
    let host = if let Some(end) = authority.strip_prefix('[').and_then(|r| r.find(']')) {
        &authority[1..=end]
    } else {
        match authority.rsplit_once(':') {
            Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => h,
            _ => authority,
        }
    };

    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        return v4.is_loopback() || v4.is_private();
    }
    if let Ok(v6) = host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::Ipv6Addr>() {
        return v6.is_loopback();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::is_local_origin;

    #[test]
    fn accepts_real_local_origins() {
        for o in [
            "http://localhost:3000",
            "http://127.0.0.1:8034",
            "http://192.168.1.50:3000",
            "http://10.0.0.7:3000",
            "http://172.16.4.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(is_local_origin(o), "should allow {o}");
        }
    }

    #[test]
    fn rejects_hosts_that_merely_look_local() {
        // The regression this guards: a prefix match on "http://10." also
        // accepts a registrable domain whose first label starts with a digit.
        for o in [
            "http://10.evil.com",
            "http://192.168.evil.com",
            "http://127.0.0.1.evil.com",
            "http://localhost.evil.com",
            "https://10.0.0.7:3000",
            "http://8.8.8.8",
        ] {
            assert!(!is_local_origin(o), "should reject {o}");
        }
    }
}
