//! Token-usage analytics for the admin dashboard.
//!
//! Reads the append-only `db_token_usage` ledger (written by the chat loop and
//! the embeddings module) and rolls it up three ways — per model, per source,
//! and per day — with an estimated USD cost. Pricing comes from the per-model
//! `price_*` columns on `db_llm_models` (USD per 1M tokens); embeddings use a
//! fixed fallback rate since the Azure deployment isn't a `db_llm_models` row.

use std::collections::HashMap;

use actix_web::{web, HttpResponse, Responder};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::json;

use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

/// USD per 1M tokens for `text-embedding-3-large` (cache-free). Embeddings have
/// no `db_llm_models` row, so this is the fallback used when costing them.
const EMBED_PRICE_PER_1M: f64 = 0.13;

#[derive(Debug, Deserialize)]
pub struct UsageQuery {
    /// Inclusive lower bound (RFC3339 datetime or `YYYY-MM-DD`).
    pub from: Option<String>,
    /// Exclusive upper bound (RFC3339 datetime or `YYYY-MM-DD`).
    pub to: Option<String>,
    /// Restrict to a single source (e.g. `chat`, `embedding:notes`).
    pub source: Option<String>,
    /// Restrict to a single model label.
    pub model: Option<String>,
}

/// Parse a date/datetime filter; returns None for empty or unparseable input
/// (the SQL treats None as "no bound").
fn parse_bound(s: &Option<String>) -> Option<DateTime<Utc>> {
    let raw = s.as_ref()?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|naive| DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

/// Cost in USD for one aggregated bucket, given a (model → prices) lookup.
/// Cache-write tokens (Anthropic) bill at ~1.25x the input rate.
fn cost_for(
    model: &str,
    kind: &str,
    ti: i64,
    to: i64,
    tc: i64,
    tw: i64,
    prices: &HashMap<String, (f64, f64, f64)>,
) -> f64 {
    if kind == "embedding" {
        return ti as f64 * EMBED_PRICE_PER_1M / 1_000_000.0;
    }
    let (pin, pout, pcached) = prices.get(model).copied().unwrap_or((0.0, 0.0, 0.0));
    (ti as f64 * pin + to as f64 * pout + tc as f64 * pcached + tw as f64 * pin * 1.25)
        / 1_000_000.0
}

#[derive(Default, Clone)]
struct Bucket {
    provider_kind: Option<String>,
    kind: String,
    ti: i64,
    to: i64,
    tc: i64,
    tw: i64,
    calls: i64,
    cost: f64,
}

impl Bucket {
    fn add(&mut self, ti: i64, to: i64, tc: i64, tw: i64, calls: i64, cost: f64) {
        self.ti += ti;
        self.to += to;
        self.tc += tc;
        self.tw += tw;
        self.calls += calls;
        self.cost += cost;
    }
    fn json(&self, key_field: &str, key_val: &str) -> serde_json::Value {
        json!({
            key_field: key_val,
            "provider_kind": self.provider_kind,
            "kind": self.kind,
            "tokens_input": self.ti,
            "tokens_output": self.to,
            "tokens_cached": self.tc,
            "tokens_cache_write": self.tw,
            "total_tokens": self.ti + self.to + self.tc + self.tw,
            "calls": self.calls,
            "cost_usd": self.cost,
        })
    }
}

/// GET /agents/usage — aggregated token spend with optional date/source/model
/// filters. Returns `{ summary, by_model, by_source, by_day }`.
pub async fn usage(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<UsageQuery>,
) -> impl Responder {
    let from = parse_bound(&q.from);
    let to = parse_bound(&q.to);

    // Per-model prices (USD per 1M tokens) keyed by model label.
    let price_rows: Vec<(String, String, f64, f64, f64)> = sqlx::query_as(
        "SELECT m.model_id, p.kind, m.price_input, m.price_output, m.price_cached \
         FROM db_llm_models m JOIN db_llm_providers p ON p.id = m.provider_id \
         ORDER BY p.kind, m.model_id",
    )
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();
    let prices: HashMap<String, (f64, f64, f64)> = price_rows
        .iter()
        .map(|(m, _, i, o, c)| (m.clone(), (*i, *o, *c)))
        .collect();

    // Configured rate card, echoed back so the dashboard can show what each
    // model bills at. Embeddings get their fixed fallback row appended.
    let mut pricing: Vec<serde_json::Value> = price_rows
        .iter()
        .map(|(m, p, i, o, c)| {
            json!({
                "model": m,
                "provider_kind": p,
                "price_input": i,
                "price_output": o,
                "price_cached": c,
            })
        })
        .collect();
    pricing.push(json!({
        "model": "text-embedding-3-large",
        "provider_kind": "azure",
        "price_input": EMBED_PRICE_PER_1M,
        "price_output": 0.0,
        "price_cached": 0.0,
    }));

    // One detailed grouped read; we fold it into the three views in Rust so the
    // per-row cost (which depends on model pricing) stays correct everywhere.
    let rows: Vec<(NaiveDate, String, String, Option<String>, String, i64, i64, i64, i64, i64)> =
        sqlx::query_as(
            "SELECT date_trunc('day', created_at)::date AS day, model, source, provider_kind, kind, \
                    SUM(tokens_input)::bigint, SUM(tokens_output)::bigint, \
                    SUM(tokens_cached)::bigint, SUM(tokens_cache_write)::bigint, COUNT(*)::bigint \
             FROM db_token_usage \
             WHERE ($1::timestamptz IS NULL OR created_at >= $1) \
               AND ($2::timestamptz IS NULL OR created_at < $2) \
               AND ($3::text IS NULL OR source = $3) \
               AND ($4::text IS NULL OR model = $4) \
             GROUP BY day, model, source, provider_kind, kind \
             ORDER BY day",
        )
        .bind(from)
        .bind(to)
        .bind(&q.source)
        .bind(&q.model)
        .fetch_all(pool.get_ref())
        .await
        .unwrap_or_default();

    let mut by_model: HashMap<String, Bucket> = HashMap::new();
    let mut by_source: HashMap<String, Bucket> = HashMap::new();
    let mut by_day: HashMap<String, Bucket> = HashMap::new();
    let (mut ti_t, mut to_t, mut tc_t, mut tw_t, mut calls_t, mut cost_t) = (0i64, 0i64, 0i64, 0i64, 0i64, 0f64);

    for (day, model, source, provider_kind, kind, ti, to, tc, tw, calls) in rows {
        let cost = cost_for(&model, &kind, ti, to, tc, tw, &prices);
        ti_t += ti;
        to_t += to;
        tc_t += tc;
        tw_t += tw;
        calls_t += calls;
        cost_t += cost;

        let m = by_model.entry(model.clone()).or_default();
        if m.provider_kind.is_none() {
            m.provider_kind = provider_kind.clone();
        }
        if m.kind.is_empty() {
            m.kind = kind.clone();
        }
        m.add(ti, to, tc, tw, calls, cost);

        let s = by_source.entry(source.clone()).or_default();
        if s.kind.is_empty() {
            s.kind = kind.clone();
        }
        s.add(ti, to, tc, tw, calls, cost);

        let d = by_day.entry(day.to_string()).or_default();
        d.add(ti, to, tc, tw, calls, cost);
    }

    let mut by_model: Vec<_> = by_model
        .iter()
        .map(|(k, b)| (b.ti + b.to + b.tc + b.tw, b.json("model", k)))
        .collect();
    by_model.sort_by(|a, b| b.0.cmp(&a.0));
    let by_model: Vec<_> = by_model.into_iter().map(|(_, v)| v).collect();

    let mut by_source: Vec<_> = by_source
        .iter()
        .map(|(k, b)| (b.ti + b.to + b.tc + b.tw, b.json("source", k)))
        .collect();
    by_source.sort_by(|a, b| b.0.cmp(&a.0));
    let by_source: Vec<_> = by_source.into_iter().map(|(_, v)| v).collect();

    let mut by_day: Vec<_> = by_day.into_iter().collect();
    by_day.sort_by(|a, b| a.0.cmp(&b.0));
    let by_day: Vec<_> = by_day.iter().map(|(k, b)| b.json("day", k)).collect();

    HttpResponse::Ok().json(json!({
        "summary": {
            "tokens_input": ti_t,
            "tokens_output": to_t,
            "tokens_cached": tc_t,
            "tokens_cache_write": tw_t,
            "total_tokens": ti_t + to_t + tc_t + tw_t,
            "calls": calls_t,
            "cost_usd": cost_t,
        },
        "by_model": by_model,
        "by_source": by_source,
        "by_day": by_day,
        "pricing": pricing,
    }))
}
