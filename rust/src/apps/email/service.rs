//! SMTP send + IMAP read for user-managed email accounts.
//!
//! Connection settings come from the `email_accounts` table (Services → Email),
//! not env vars. System mail (verification / password-reset) and the agent
//! `send_email` tool send through the account flagged `is_default` (which must
//! also be `send_enabled`). Passwords are decrypted via `apps::shares::crypto`
//! only at connection time.

use lettre::{
    message::header::ContentType, message::Mailbox,
    transport::smtp::authentication::Credentials, AsyncSmtpTransport, AsyncTransport, Message,
    Tokio1Executor,
};

use super::models::EmailAccount;
use crate::apps::shares::crypto;
use crate::db::db::DbPool;

const ACCOUNT_COLS: &str = "id, label, email_address, send_enabled, smtp_host, smtp_port, \
    smtp_security, smtp_username, smtp_password, read_enabled, imap_host, imap_port, \
    imap_security, imap_username, imap_password, is_default, created_at, updated_at";

/// Resolve the system sending account: the default row that also has send on.
pub async fn default_sender(pool: &DbPool) -> Result<EmailAccount, String> {
    sqlx::query_as::<_, EmailAccount>(&format!(
        "SELECT {ACCOUNT_COLS} FROM email_accounts WHERE is_default AND send_enabled LIMIT 1"
    ))
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("DB error resolving default sender: {e}"))?
    .ok_or_else(|| {
        "No default sending account configured (Services → Email — add an account, enable \
         sending, and mark it as the system sender)"
            .to_string()
    })
}

/// Build an async SMTP transport honoring the security mode.
fn build_transport(
    host: &str,
    port: u16,
    security: &str,
    user: String,
    password: String,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let creds = Credentials::new(user, password);
    let builder = match security {
        // Implicit TLS, typically port 465.
        "ssl" | "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(host)
            .map_err(|e| format!("SMTP relay error: {e}"))?,
        // Plaintext / opportunistic — discouraged, but supported for LAN relays.
        "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host),
        // Default: STARTTLS, typically port 587.
        _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
            .map_err(|e| format!("SMTP relay error: {e}"))?,
    };
    Ok(builder.port(port).credentials(creds).build())
}

/// Build a transport from a resolved account (decrypting its password).
async fn transport_for(
    pool: &DbPool,
    acct: &EmailAccount,
) -> Result<(AsyncSmtpTransport<Tokio1Executor>, Mailbox), String> {
    let password = crypto::decrypt(pool, &acct.smtp_password)
        .await
        .ok_or_else(|| "could not decrypt SMTP password".to_string())?;
    let user = if acct.smtp_username.trim().is_empty() {
        acct.email_address.clone()
    } else {
        acct.smtp_username.clone()
    };
    let from: Mailbox = acct
        .email_address
        .parse()
        .map_err(|e: lettre::address::AddressError| format!("Invalid FROM address: {e}"))?;
    let transport = build_transport(
        &acct.smtp_host,
        acct.smtp_port as u16,
        &acct.smtp_security,
        user,
        password,
    )?;
    Ok((transport, from))
}

/// Generic plain-text send through the default account. Used by the agent
/// `send_email` tool. `bcc` is blind-copied (the cron flow BCCs the owner).
pub async fn send(
    pool: &DbPool,
    to_email: &str,
    subject: &str,
    body: &str,
    bcc: Option<&str>,
) -> Result<(), String> {
    let acct = default_sender(pool).await?;
    let (transport, from) = transport_for(pool, &acct).await?;
    let to: Mailbox = to_email
        .parse()
        .map_err(|e: lettre::address::AddressError| format!("Invalid TO address: {e}"))?;

    let mut builder = Message::builder().from(from).to(to).subject(subject);
    if let Some(b) = bcc.filter(|s| !s.trim().is_empty() && *s != to_email) {
        let bcc_box: Mailbox = b
            .parse()
            .map_err(|e: lettre::address::AddressError| format!("Invalid BCC address: {e}"))?;
        builder = builder.bcc(bcc_box);
    }
    let email = builder
        .header(ContentType::TEXT_PLAIN)
        .body(body.to_string())
        .map_err(|e| format!("Email build error: {e}"))?;

    transport
        .send(email)
        .await
        .map_err(|e| format!("SMTP send error: {e}"))?;
    Ok(())
}

/// Send an HTML email through the default account (system mail helper).
async fn send_html(
    pool: &DbPool,
    to_email: &str,
    subject: &str,
    html: String,
) -> Result<(), String> {
    let acct = default_sender(pool).await?;
    let (transport, from) = transport_for(pool, &acct).await?;
    let email = Message::builder()
        .from(from)
        .to(to_email
            .parse()
            .map_err(|e: lettre::address::AddressError| format!("Invalid TO address: {e}"))?)
        .subject(subject)
        .header(ContentType::TEXT_HTML)
        .body(html)
        .map_err(|e| format!("Email build error: {e}"))?;
    transport
        .send(email)
        .await
        .map_err(|e| format!("SMTP send error: {e}"))?;
    Ok(())
}

pub async fn send_verification_email(
    pool: &DbPool,
    to_email: &str,
    token: &str,
    frontend_base_url: &str,
) -> Result<(), String> {
    let base = if frontend_base_url.ends_with('/') {
        frontend_base_url.to_owned()
    } else {
        format!("{}/", frontend_base_url)
    };
    let verify_link = format!("{}verify-email?token={}", base, token);
    let html = format!(
        r#"<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>Verify Your Email Address</h2>
  <p>Thank you for registering! Click the button below to verify your email address.</p>
  <p style="margin:32px 0;">
    <a href="{url}" style="background:#1677ff;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:16px;">
      Verify Email
    </a>
  </p>
  <p style="color:#666;font-size:13px;">Or copy this link into your browser:<br><a href="{url}">{url}</a></p>
  <p style="color:#999;font-size:12px;">This link expires in 24 hours. If you did not create an account, you can ignore this email.</p>
</body>
</html>"#,
        url = verify_link
    );
    send_html(pool, to_email, "Verify your email address", html).await
}

pub async fn send_password_reset_email(
    pool: &DbPool,
    to_email: &str,
    token: &str,
    frontend_base_url: &str,
) -> Result<(), String> {
    let base = if frontend_base_url.ends_with('/') {
        frontend_base_url.to_owned()
    } else {
        format!("{}/", frontend_base_url)
    };
    let reset_link = format!("{}reset-password?token={}", base, token);
    let html = format!(
        r#"<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>Password Reset Request</h2>
  <p>We received a request to reset your password. Click the button below to set a new password.</p>
  <p style="margin:32px 0;">
    <a href="{url}" style="background:#1677ff;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:16px;">
      Reset Password
    </a>
  </p>
  <p style="color:#666;font-size:13px;">Or copy this link into your browser:<br><a href="{url}">{url}</a></p>
  <p style="color:#999;font-size:12px;">This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>
</body>
</html>"#,
        url = reset_link
    );
    send_html(pool, to_email, "Reset your password", html).await
}

/// Send a one-off test message via explicit SMTP settings (no DB lookup).
pub async fn smtp_test(
    host: &str,
    port: u16,
    security: &str,
    user: &str,
    password: &str,
    from_addr: &str,
    to_addr: &str,
) -> Result<String, String> {
    let transport = build_transport(host, port, security, user.to_string(), password.to_string())?;
    let email = Message::builder()
        .from(
            from_addr
                .parse()
                .map_err(|e: lettre::address::AddressError| format!("Invalid FROM address: {e}"))?,
        )
        .to(to_addr
            .parse()
            .map_err(|e: lettre::address::AddressError| format!("Invalid TO address: {e}"))?)
        .subject("Piuma Vault — SMTP test")
        .header(ContentType::TEXT_PLAIN)
        .body("This is a test message confirming your SMTP settings work.".to_string())
        .map_err(|e| format!("Email build error: {e}"))?;
    transport
        .send(email)
        .await
        .map_err(|e| format!("SMTP send error: {e}"))?;
    Ok(format!("Test email sent to {to_addr}"))
}

/// Resolve a reading (IMAP) account. Prefers the requested label/address, then
/// the system-default account if it reads, then the oldest read-enabled one.
/// Returns the `NO_READER` sentinel when no account has reading enabled.
pub async fn reader_account(
    pool: &DbPool,
    requested: Option<&str>,
) -> Result<EmailAccount, String> {
    let accounts = sqlx::query_as::<_, EmailAccount>(&format!(
        "SELECT {ACCOUNT_COLS} FROM email_accounts WHERE read_enabled \
         ORDER BY is_default DESC, created_at"
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| format!("DB error resolving reading account: {e}"))?;
    if accounts.is_empty() {
        return Err("NO_READER".to_string());
    }
    if let Some(req) = requested
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
    {
        return accounts
            .into_iter()
            .find(|a| a.email_address.to_lowercase() == req || a.label.to_lowercase() == req)
            .ok_or_else(|| format!("no reading account matches '{req}'"));
    }
    Ok(accounts.into_iter().next().unwrap())
}

/// A single fetched message (header fields + a plain-text snippet).
#[derive(Debug, serde::Serialize)]
pub struct EmailMessage {
    pub uid: Option<u32>,
    pub date: Option<String>,
    pub from: String,
    pub subject: String,
    pub snippet: String,
}

fn format_addr(a: &mail_parser::Addr) -> String {
    match (&a.name, &a.address) {
        (Some(n), Some(addr)) => format!("{n} <{addr}>"),
        (None, Some(addr)) => addr.to_string(),
        (Some(n), None) => n.to_string(),
        _ => String::new(),
    }
}

/// List the most recent `limit` messages in `mailbox` (newest first). Uses
/// BODY.PEEK so messages are not marked \Seen. Runs the blocking `imap` crate
/// on a blocking thread.
pub async fn imap_list(
    host: String,
    port: u16,
    security: String,
    user: String,
    password: String,
    mailbox: String,
    limit: usize,
) -> Result<Vec<EmailMessage>, String> {
    tokio::task::spawn_blocking(move || {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| format!("TLS init error: {e}"))?;
        let mut session = if security == "starttls" {
            imap::connect_starttls((host.as_str(), port), host.as_str(), &tls)
                .map_err(|e| format!("IMAP connect error: {e}"))?
                .login(&user, &password)
                .map_err(|(e, _)| format!("IMAP login failed: {e}"))?
        } else {
            imap::connect((host.as_str(), port), host.as_str(), &tls)
                .map_err(|e| format!("IMAP connect error: {e}"))?
                .login(&user, &password)
                .map_err(|(e, _)| format!("IMAP login failed: {e}"))?
        };
        let mb = session
            .select(&mailbox)
            .map_err(|e| format!("IMAP select error: {e}"))?;
        let total = mb.exists;
        if total == 0 {
            let _ = session.logout();
            return Ok(Vec::new());
        }
        let lim = (limit.clamp(1, 25)) as u32;
        let start = if total > lim { total - lim + 1 } else { 1 };
        let range = format!("{start}:{total}");
        let fetches = session
            .fetch(range, "(UID BODY.PEEK[])")
            .map_err(|e| format!("IMAP fetch error: {e}"))?;
        let mut out = Vec::new();
        for f in fetches.iter() {
            let Some(raw) = f.body() else { continue };
            let (from, subject, date, snippet) =
                match mail_parser::MessageParser::default().parse(raw) {
                    Some(m) => {
                        let from = m
                            .from()
                            .and_then(|a| a.first())
                            .map(format_addr)
                            .unwrap_or_default();
                        let subject = m.subject().unwrap_or("").to_string();
                        let date = m.date().map(|d| d.to_rfc3339());
                        let body = m.body_text(0).map(|c| c.into_owned()).unwrap_or_default();
                        let snippet: String =
                            body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(800).collect();
                        (from, subject, date, snippet)
                    }
                    None => (String::new(), String::new(), None, String::new()),
                };
            out.push(EmailMessage {
                uid: f.uid,
                date,
                from,
                subject,
                snippet,
            });
        }
        let _ = session.logout();
        out.reverse(); // newest first
        Ok(out)
    })
    .await
    .map_err(|e| format!("IMAP task error: {e}"))?
}

/// Verify IMAP credentials by logging in and selecting INBOX. Runs the blocking
/// `imap` crate on a blocking thread.
pub async fn imap_test(
    host: String,
    port: u16,
    security: String,
    user: String,
    password: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| format!("TLS init error: {e}"))?;
        let exists = if security == "starttls" {
            let client = imap::connect_starttls((host.as_str(), port), host.as_str(), &tls)
                .map_err(|e| format!("IMAP connect error: {e}"))?;
            let mut session = client
                .login(&user, &password)
                .map_err(|(e, _)| format!("IMAP login failed: {e}"))?;
            let mb = session
                .select("INBOX")
                .map_err(|e| format!("IMAP select error: {e}"))?;
            let n = mb.exists;
            let _ = session.logout();
            n
        } else {
            let client = imap::connect((host.as_str(), port), host.as_str(), &tls)
                .map_err(|e| format!("IMAP connect error: {e}"))?;
            let mut session = client
                .login(&user, &password)
                .map_err(|(e, _)| format!("IMAP login failed: {e}"))?;
            let mb = session
                .select("INBOX")
                .map_err(|e| format!("IMAP select error: {e}"))?;
            let n = mb.exists;
            let _ = session.logout();
            n
        };
        Ok(format!("Connected — INBOX has {exists} message(s)"))
    })
    .await
    .map_err(|e| format!("IMAP task error: {e}"))?
}
