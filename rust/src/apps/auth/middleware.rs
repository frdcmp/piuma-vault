use jsonwebtoken::{decode, Algorithm, Validation};
use super::models::{AuthenticatedUser, Claims};
use super::keys;
use actix_web::Error;

pub struct Auth;

impl Auth {
    pub fn validate_token(token: &str) -> Result<Claims, Error> {
        let decoding_key = keys::decoding_key();

        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = 5;

        decode::<Claims>(token, decoding_key, &validation)
            .map(|data| data.claims)
            .map_err(|e| {
                log::warn!("JWT decode error: {:?}", e);
                actix_web::error::ErrorUnauthorized("Invalid authentication token")
            })
    }
}

pub fn check_permission(user: &AuthenticatedUser, required_perm: &str) -> bool {
    user.permissions.iter().any(|p| p == required_perm || p == "admin_access")
}
