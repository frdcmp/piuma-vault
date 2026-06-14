// Centralized origin for the mobile app.
// Override via EXPO_PUBLIC_SITE_URL at build time; /api/v1 is constant.
const SITE_ORIGIN = process.env.EXPO_PUBLIC_SITE_URL || "https://vault.example.com";
const API_BASE = `${SITE_ORIGIN}/api/v1`;

export { SITE_ORIGIN, API_BASE };
