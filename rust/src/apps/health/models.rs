use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct ApiResponse {
    pub message: String,
}

#[derive(Serialize, Deserialize)]
pub struct Health {
    pub id: Option<i32>,
    pub name: String,
}

#[derive(Deserialize)]
pub struct CreateHealth {
    pub name: String,
}

#[derive(Deserialize)]
pub struct UpdateHealth {
    pub name: String,
}
