//! Admin CRUD for email accounts + SMTP/IMAP connection tests.
//! All routes require `admin_access`.

use actix_web::{web, HttpResponse, Responder};
use uuid::Uuid;

use super::models::{
    CreateEmailAccount, EmailAccount, EmailAccountResponse, TestConnectionRequest,
    UpdateEmailAccount,
};
use super::service;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::shares::crypto;
use crate::db::db::DbPool;

const COLS: &str = "id, label, email_address, send_enabled, smtp_host, smtp_port, smtp_security, \
    smtp_username, smtp_password, read_enabled, imap_host, imap_port, imap_security, \
    imap_username, imap_password, is_default, created_at, updated_at";

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(serde_json::json!({ "error": "admin_access required" }))
}
fn err(msg: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "error": msg.into() })
}

/// Clear `is_default` on all rows (so a new default can be set without tripping
/// the partial unique index).
async fn clear_default(pool: &DbPool) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE email_accounts SET is_default = false WHERE is_default")
        .execute(pool)
        .await?;
    Ok(())
}

/// GET /admin/email/accounts — list all accounts (secrets masked).
pub async fn list_accounts(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    match sqlx::query_as::<_, EmailAccount>(&format!(
        "SELECT {COLS} FROM email_accounts ORDER BY created_at"
    ))
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => HttpResponse::Ok().json(
            rows.into_iter()
                .map(EmailAccountResponse::from)
                .collect::<Vec<_>>(),
        ),
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// POST /admin/email/accounts — create.
pub async fn create_account(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<CreateEmailAccount>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let b = body.into_inner();
    if b.label.trim().is_empty() || b.email_address.trim().is_empty() {
        return HttpResponse::BadRequest().json(err("label and email_address are required"));
    }

    let smtp_pw = encrypt_or_empty(pool, &b.smtp_password).await;
    let imap_pw = encrypt_or_empty(pool, &b.imap_password).await;

    if b.is_default {
        if let Err(e) = clear_default(pool).await {
            return HttpResponse::InternalServerError().json(err(format!("DB error: {e}")));
        }
    }

    let row = sqlx::query_as::<_, EmailAccount>(&format!(
        "INSERT INTO email_accounts (label, email_address, send_enabled, smtp_host, smtp_port, \
         smtp_security, smtp_username, smtp_password, read_enabled, imap_host, imap_port, \
         imap_security, imap_username, imap_password, is_default) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING {COLS}"
    ))
    .bind(b.label.trim())
    .bind(b.email_address.trim())
    .bind(b.send_enabled)
    .bind(b.smtp_host.trim())
    .bind(b.smtp_port)
    .bind(&b.smtp_security)
    .bind(b.smtp_username.trim())
    .bind(&smtp_pw)
    .bind(b.read_enabled)
    .bind(b.imap_host.trim())
    .bind(b.imap_port)
    .bind(&b.imap_security)
    .bind(b.imap_username.trim())
    .bind(&imap_pw)
    .bind(b.is_default)
    .fetch_one(pool)
    .await;

    match row {
        Ok(a) => HttpResponse::Created().json(EmailAccountResponse::from(a)),
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// PUT /admin/email/accounts/{id} — partial update (leave-blank-to-keep secrets).
pub async fn update_account(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<UpdateEmailAccount>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let id = path.into_inner();
    let b = body.into_inner();

    let Some(cur) = (match sqlx::query_as::<_, EmailAccount>(&format!(
        "SELECT {COLS} FROM email_accounts WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
    {
        Ok(v) => v,
        Err(e) => return HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }) else {
        return HttpResponse::NotFound().json(err("account not found"));
    };

    // Secrets: None = keep, Some("") = clear, Some(non-empty) = replace.
    let smtp_pw = match b.smtp_password.as_deref() {
        None => cur.smtp_password.clone(),
        Some(s) => encrypt_or_empty(pool, s).await,
    };
    let imap_pw = match b.imap_password.as_deref() {
        None => cur.imap_password.clone(),
        Some(s) => encrypt_or_empty(pool, s).await,
    };

    let is_default = b.is_default.unwrap_or(cur.is_default);
    if is_default && !cur.is_default {
        if let Err(e) = clear_default(pool).await {
            return HttpResponse::InternalServerError().json(err(format!("DB error: {e}")));
        }
    }

    let row = sqlx::query_as::<_, EmailAccount>(&format!(
        "UPDATE email_accounts SET label=$1, email_address=$2, send_enabled=$3, smtp_host=$4, \
         smtp_port=$5, smtp_security=$6, smtp_username=$7, smtp_password=$8, read_enabled=$9, \
         imap_host=$10, imap_port=$11, imap_security=$12, imap_username=$13, imap_password=$14, \
         is_default=$15, updated_at=NOW() WHERE id=$16 RETURNING {COLS}"
    ))
    .bind(b.label.unwrap_or(cur.label).trim().to_string())
    .bind(b.email_address.unwrap_or(cur.email_address).trim().to_string())
    .bind(b.send_enabled.unwrap_or(cur.send_enabled))
    .bind(b.smtp_host.unwrap_or(cur.smtp_host).trim().to_string())
    .bind(b.smtp_port.unwrap_or(cur.smtp_port))
    .bind(b.smtp_security.unwrap_or(cur.smtp_security))
    .bind(b.smtp_username.unwrap_or(cur.smtp_username).trim().to_string())
    .bind(&smtp_pw)
    .bind(b.read_enabled.unwrap_or(cur.read_enabled))
    .bind(b.imap_host.unwrap_or(cur.imap_host).trim().to_string())
    .bind(b.imap_port.unwrap_or(cur.imap_port))
    .bind(b.imap_security.unwrap_or(cur.imap_security))
    .bind(b.imap_username.unwrap_or(cur.imap_username).trim().to_string())
    .bind(&imap_pw)
    .bind(is_default)
    .bind(id)
    .fetch_one(pool)
    .await;

    match row {
        Ok(a) => HttpResponse::Ok().json(EmailAccountResponse::from(a)),
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// DELETE /admin/email/accounts/{id}
pub async fn delete_account(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    match sqlx::query("DELETE FROM email_accounts WHERE id = $1")
        .bind(path.into_inner())
        .execute(pool.get_ref())
        .await
    {
        Ok(r) if r.rows_affected() == 0 => {
            HttpResponse::NotFound().json(err("account not found"))
        }
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({ "ok": true })),
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// POST /admin/email/accounts/{id}/default — mark as system sender.
pub async fn set_default(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let id = path.into_inner();
    if let Err(e) = clear_default(pool).await {
        return HttpResponse::InternalServerError().json(err(format!("DB error: {e}")));
    }
    match sqlx::query(
        "UPDATE email_accounts SET is_default = true, send_enabled = true, updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .execute(pool)
    .await
    {
        Ok(r) if r.rows_affected() == 0 => HttpResponse::NotFound().json(err("account not found")),
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({ "ok": true })),
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// Resolve effective (host, port, security, username, password) for a test,
/// merging unsaved overrides with a saved account's stored secret.
async fn resolve_test(
    pool: &DbPool,
    req: &TestConnectionRequest,
    smtp: bool,
) -> Result<(String, u16, String, String, String, String), String> {
    let acct = match req.id {
        Some(id) => sqlx::query_as::<_, EmailAccount>(&format!(
            "SELECT {COLS} FROM email_accounts WHERE id = $1"
        ))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error: {e}"))?,
        None => None,
    };

    let pick = |ov: &Option<String>, saved: Option<&str>, default: &str| -> String {
        ov.as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .or_else(|| saved.map(|s| s.to_string()))
            .unwrap_or_else(|| default.to_string())
    };

    let (host, port, security, username, enc_pw, from_addr) = if smtp {
        (
            pick(&req.host, acct.as_ref().map(|a| a.smtp_host.as_str()), ""),
            req.port.or(acct.as_ref().map(|a| a.smtp_port)).unwrap_or(587) as u16,
            pick(&req.security, acct.as_ref().map(|a| a.smtp_security.as_str()), "starttls"),
            pick(&req.username, acct.as_ref().map(|a| a.smtp_username.as_str()), ""),
            acct.as_ref().map(|a| a.smtp_password.clone()).unwrap_or_default(),
            acct.as_ref().map(|a| a.email_address.clone()).unwrap_or_default(),
        )
    } else {
        (
            pick(&req.host, acct.as_ref().map(|a| a.imap_host.as_str()), ""),
            req.port.or(acct.as_ref().map(|a| a.imap_port)).unwrap_or(993) as u16,
            pick(&req.security, acct.as_ref().map(|a| a.imap_security.as_str()), "ssl"),
            pick(&req.username, acct.as_ref().map(|a| a.imap_username.as_str()), ""),
            acct.as_ref().map(|a| a.imap_password.clone()).unwrap_or_default(),
            acct.as_ref().map(|a| a.email_address.clone()).unwrap_or_default(),
        )
    };

    // Password: a typed override wins; otherwise decrypt the stored secret.
    let password = match req.password.as_deref() {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => {
            if enc_pw.trim().is_empty() {
                return Err("no password provided and none stored".to_string());
            }
            crypto::decrypt(pool, &enc_pw)
                .await
                .ok_or_else(|| "could not decrypt stored password".to_string())?
        }
    };

    if host.trim().is_empty() {
        return Err("host is required".to_string());
    }
    let user = if username.trim().is_empty() {
        from_addr.clone()
    } else {
        username
    };
    Ok((host, port, security, user, password, from_addr))
}

/// POST /admin/email/accounts/test/smtp
pub async fn test_smtp(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<TestConnectionRequest>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let req = body.into_inner();
    let (host, port, security, username, password, from_addr) =
        match resolve_test(pool.get_ref(), &req, true).await {
            Ok(v) => v,
            Err(e) => return HttpResponse::Ok().json(serde_json::json!({ "ok": false, "message": e })),
        };
    let from = if from_addr.trim().is_empty() { username.clone() } else { from_addr };
    let to = req
        .to
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| from.clone());

    match service::smtp_test(&host, port, &security, &username, &password, &from, &to).await {
        Ok(msg) => HttpResponse::Ok().json(serde_json::json!({ "ok": true, "message": msg })),
        Err(e) => HttpResponse::Ok().json(serde_json::json!({ "ok": false, "message": e })),
    }
}

/// POST /admin/email/accounts/test/imap
pub async fn test_imap(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<TestConnectionRequest>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let req = body.into_inner();
    let (host, port, security, username, password, _from) =
        match resolve_test(pool.get_ref(), &req, false).await {
            Ok(v) => v,
            Err(e) => return HttpResponse::Ok().json(serde_json::json!({ "ok": false, "message": e })),
        };
    match service::imap_test(host, port, security, username, password).await {
        Ok(msg) => HttpResponse::Ok().json(serde_json::json!({ "ok": true, "message": msg })),
        Err(e) => HttpResponse::Ok().json(serde_json::json!({ "ok": false, "message": e })),
    }
}

/// Encrypt a plaintext secret, or store empty string when blank.
async fn encrypt_or_empty(pool: &DbPool, plaintext: &str) -> String {
    if plaintext.trim().is_empty() {
        String::new()
    } else {
        crypto::encrypt(pool, plaintext.trim())
            .await
            .unwrap_or_default()
    }
}
