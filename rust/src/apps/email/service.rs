use lettre::{
    message::header::ContentType,
    message::Mailbox,
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use std::env;

fn smtp_config() -> Result<(String, u16, String, String), String> {
    let host = env::var("EMAIL_HOST").unwrap_or_else(|_| "smtp.gmail.com".to_string());
    let port: u16 = env::var("EMAIL_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(587);
    let user = env::var("EMAIL_HOST_USER")
        .map_err(|_| "EMAIL_HOST_USER env var not set".to_string())?;
    let password = env::var("EMAIL_HOST_PASSWORD")
        .map_err(|_| "EMAIL_HOST_PASSWORD env var not set".to_string())?;
    Ok((host, port, user, password))
}

async fn build_transport(host: &str, port: u16, user: String, password: String)
    -> Result<AsyncSmtpTransport<Tokio1Executor>, String>
{
    let creds = Credentials::new(user, password);
    let transport = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
        .map_err(|e| format!("SMTP relay error: {}", e))?
        .port(port)
        .credentials(creds)
        .build();
    Ok(transport)
}

/// Generic plain-text email send, used by the agent `send_email` tool. `bcc` is
/// blind-copied (the cron flow BCCs the vault owner for an audit trail).
pub async fn send(to_email: &str, subject: &str, body: &str, bcc: Option<&str>) -> Result<(), String> {
    let (host, port, user, password) = smtp_config()?;
    let from: Mailbox = user
        .parse()
        .map_err(|e: lettre::address::AddressError| format!("Invalid FROM address: {e}"))?;
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

    let transport = build_transport(&host, port, user, password).await?;
    transport.send(email).await.map_err(|e| format!("SMTP send error: {e}"))?;
    Ok(())
}

pub async fn send_verification_email(to_email: &str, token: &str, frontend_base_url: &str) -> Result<(), String> {
    let (host, port, user, password) = smtp_config()?;
    let base = if frontend_base_url.ends_with('/') { frontend_base_url.to_owned() } else { format!("{}/", frontend_base_url) };
    let verify_link = format!("{}verify-email?token={}", base, token);

    let email = Message::builder()
        .from(user.parse().map_err(|e: lettre::address::AddressError| format!("Invalid FROM address: {}", e))?)
        .to(to_email.parse().map_err(|e: lettre::address::AddressError| format!("Invalid TO address: {}", e))?)
        .subject("Verify your email address")
        .header(ContentType::TEXT_HTML)
        .body(format!(r#"<!DOCTYPE html>
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
</html>"#, url = verify_link))
        .map_err(|e| format!("Email build error: {}", e))?;

    let transport = build_transport(&host, port, user, password).await?;
    transport.send(email).await.map_err(|e| format!("SMTP send error: {}", e))?;
    Ok(())
}

pub async fn send_password_reset_email(to_email: &str, token: &str, frontend_base_url: &str) -> Result<(), String> {
    let (host, port, user, password) = smtp_config()?;
    let base = if frontend_base_url.ends_with('/') { frontend_base_url.to_owned() } else { format!("{}/", frontend_base_url) };
    let reset_link = format!("{}reset-password?token={}", base, token);

    let email = Message::builder()
        .from(user.parse().map_err(|e: lettre::address::AddressError| format!("Invalid FROM address: {}", e))?)
        .to(to_email.parse().map_err(|e: lettre::address::AddressError| format!("Invalid TO address: {}", e))?)
        .subject("Reset your password")
        .header(ContentType::TEXT_HTML)
        .body(format!(r#"<!DOCTYPE html>
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
</html>"#, url = reset_link))
        .map_err(|e| format!("Email build error: {}", e))?;

    let transport = build_transport(&host, port, user, password).await?;
    transport.send(email).await.map_err(|e| format!("SMTP send error: {}", e))?;
    Ok(())
}
