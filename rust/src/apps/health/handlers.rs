use actix_web::{HttpResponse, Responder, web};
use sqlx;
use crate::db::db::DbPool;
use super::models::{ApiResponse, Health, CreateHealth, UpdateHealth};
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::auth::middleware::check_permission;

pub async fn hello() -> impl Responder {
    let response = ApiResponse {
        message: "Hello from Rust API Server!".to_string(),
    };
    HttpResponse::Ok().json(response)
}

pub async fn get_healths(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, "example_employee.view") {
        return HttpResponse::Forbidden().json(ApiResponse { 
            message: "Insufficient permissions. Required: example_employee.view".to_string() 
        });
    }

    let rows: Vec<(i32, String)> = sqlx::query_as("SELECT id, name FROM health")
        .fetch_all(pool.get_ref())
        .await
        .unwrap();
    let healths: Vec<Health> = rows.into_iter().map(|(id, name)| Health { id: Some(id), name }).collect();
    HttpResponse::Ok().json(healths)
}

pub async fn get_health(path: web::Path<i32>, pool: web::Data<DbPool>) -> impl Responder {
    let id = path.into_inner();
    let row: Option<(i32, String)> = sqlx::query_as("SELECT id, name FROM health WHERE id = $1")
        .bind(id)
        .fetch_optional(pool.get_ref())
        .await
        .unwrap();
    match row {
        Some((id, name)) => HttpResponse::Ok().json(Health { id: Some(id), name }),
        None => HttpResponse::NotFound().json(ApiResponse { message: "Not found".to_string() }),
    }
}

pub async fn create_health(health: web::Json<CreateHealth>, pool: web::Data<DbPool>) -> impl Responder {
    let row: (i32,) = sqlx::query_as("INSERT INTO health (name) VALUES ($1) RETURNING id")
        .bind(&health.name)
        .fetch_one(pool.get_ref())
        .await
        .unwrap();
    let id = row.0;
    HttpResponse::Created().json(Health { id: Some(id), name: health.name.clone() })
}

pub async fn update_health(path: web::Path<i32>, health: web::Json<UpdateHealth>, pool: web::Data<DbPool>) -> impl Responder {
    let id = path.into_inner();
    let result = sqlx::query("UPDATE health SET name = $1 WHERE id = $2")
        .bind(&health.name)
        .bind(id)
        .execute(pool.get_ref())
        .await
        .unwrap();
    if result.rows_affected() > 0 {
        HttpResponse::Ok().json(Health { id: Some(id), name: health.name.clone() })
    } else {
        HttpResponse::NotFound().json(ApiResponse { message: "Not found".to_string() })
    }
}

pub async fn delete_health(path: web::Path<i32>, pool: web::Data<DbPool>) -> impl Responder {
    let id = path.into_inner();
    let result = sqlx::query("DELETE FROM health WHERE id = $1")
        .bind(id)
        .execute(pool.get_ref())
        .await
        .unwrap();
    if result.rows_affected() > 0 {
        HttpResponse::Ok().json(ApiResponse { message: "Deleted".to_string() })
    } else {
        HttpResponse::NotFound().json(ApiResponse { message: "Not found".to_string() })
    }
}
