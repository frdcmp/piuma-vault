//! GitHub tools — let the agent read and (carefully) write the user's GitHub
//! repos through a personal access token configured in admin → Services.
//!
//! This is single-tenant: there's one token for the vault (not per-user), so
//! these handlers take `(pool, args)` like the web tools rather than a
//! `user_id`. Read tools project the GitHub JSON down to the useful fields to
//! keep tool results small; write tools are deliberately limited to additive
//! operations (no force-push, no deletes).

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};

use super::{opt_string, req_str};
use crate::apps::settings::store;
use crate::db::db::DbPool;

const MAX_TEXT: usize = 12_000; // cap chars of file content returned to the model
const UA: &str = "PiumaVault/1.0 (+agent github)";

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "github_list_repos",
            "List the GitHub repositories the configured account can access.",
            json!({
                "type": "object",
                "properties": {
                    "per_page": { "type": "integer", "description": "max repos (default 30, max 100)" },
                    "sort": { "type": "string", "description": "created | updated | pushed | full_name (default updated)" }
                }
            }),
        ),
        (
            "github_search_repos",
            "Search GitHub repositories by query (GitHub search syntax).",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "per_page": { "type": "integer", "description": "max results (default 10, max 50)" }
                },
                "required": ["query"]
            }),
        ),
        (
            "github_read_file",
            "Read a text file from a GitHub repository.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string", "description": "owner/org login" },
                    "repo": { "type": "string" },
                    "path": { "type": "string", "description": "file path, e.g. src/main.rs" },
                    "ref": { "type": "string", "description": "branch, tag, or commit sha (default: repo default branch)" }
                },
                "required": ["owner", "repo", "path"]
            }),
        ),
        (
            "github_list_dir",
            "List the contents of a directory in a GitHub repository.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "path": { "type": "string", "description": "directory path; empty/omitted = repo root" },
                    "ref": { "type": "string", "description": "branch, tag, or commit sha" }
                },
                "required": ["owner", "repo"]
            }),
        ),
        (
            "github_list_commits",
            "List recent commits on a branch of a GitHub repository.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "branch": { "type": "string", "description": "branch/sha (default: repo default branch)" },
                    "path": { "type": "string", "description": "only commits touching this path (optional)" },
                    "limit": { "type": "integer", "description": "max commits (default 10, max 30)" }
                },
                "required": ["owner", "repo"]
            }),
        ),
        (
            "github_list_branches",
            "List branches of a GitHub repository.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "per_page": { "type": "integer", "description": "max branches (default 30, max 100)" }
                },
                "required": ["owner", "repo"]
            }),
        ),
        (
            "github_list_issues",
            "List issues of a GitHub repository (pull requests excluded).",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "state": { "type": "string", "description": "open | closed | all (default open)" },
                    "per_page": { "type": "integer", "description": "max issues (default 20, max 50)" }
                },
                "required": ["owner", "repo"]
            }),
        ),
        (
            "github_list_prs",
            "List pull requests of a GitHub repository.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "state": { "type": "string", "description": "open | closed | all (default open)" },
                    "per_page": { "type": "integer", "description": "max PRs (default 20, max 50)" }
                },
                "required": ["owner", "repo"]
            }),
        ),
        (
            "github_create_or_update_file",
            "Create or update a single text file in a GitHub repository (one commit). Reads the existing file's blob sha first when updating.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "path": { "type": "string" },
                    "content": { "type": "string", "description": "full new file content (UTF-8 text)" },
                    "message": { "type": "string", "description": "commit message" },
                    "branch": { "type": "string", "description": "target branch (default: repo default branch)" }
                },
                "required": ["owner", "repo", "path", "content", "message"]
            }),
        ),
        (
            "github_create_issue",
            "Open a new issue on a GitHub repository.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "title": { "type": "string" },
                    "body": { "type": "string", "description": "issue body (markdown, optional)" }
                },
                "required": ["owner", "repo", "title"]
            }),
        ),
        (
            "github_create_branch",
            "Create a new branch in a GitHub repository from an existing branch.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "new_branch": { "type": "string", "description": "name of the branch to create" },
                    "from_branch": { "type": "string", "description": "source branch (default: repo default branch)" }
                },
                "required": ["owner", "repo", "new_branch"]
            }),
        ),
        (
            "github_create_pull_request",
            "Open a pull request on a GitHub repository.",
            json!({
                "type": "object",
                "properties": {
                    "owner": { "type": "string" },
                    "repo": { "type": "string" },
                    "title": { "type": "string" },
                    "head": { "type": "string", "description": "branch with your changes" },
                    "base": { "type": "string", "description": "branch to merge into (default: repo default branch)" },
                    "body": { "type": "string", "description": "PR description (markdown, optional)" }
                },
                "required": ["owner", "repo", "title", "head"]
            }),
        ),
    ]
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// Apply the standard GitHub auth + version + UA headers to a request builder.
fn auth(rb: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    rb.header("Authorization", format!("Bearer {token}"))
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", UA)
}

/// Map a non-2xx GitHub response into a friendly error (surfacing its message).
async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    Err(match status.as_u16() {
        401 => format!("GitHub auth failed (401) — token invalid or expired: {msg}"),
        403 => format!("GitHub forbidden or rate-limited (403): {msg}"),
        404 => format!("GitHub: not found (404): {msg}"),
        422 => format!("GitHub: unprocessable (422): {msg}"),
        s => format!("GitHub API error ({s}): {msg}"),
    })
}

/// Resolve `(api_base, token)` from settings.
async fn cfg(pool: &DbPool) -> Result<(String, String), String> {
    let token = store::github_token(pool).await?;
    let base = store::github_api_base(pool).await;
    Ok((base, token))
}

/// Percent-encode a single path segment (owner/repo/branch names).
fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// Percent-encode a file path while preserving `/` separators.
fn enc_path(path: &str) -> String {
    path.trim_matches('/')
        .split('/')
        .map(enc)
        .collect::<Vec<_>>()
        .join("/")
}

/// GET a GitHub JSON endpoint (relative path appended to the API base).
async fn get_json(base: &str, token: &str, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let c = client()?;
    let resp = auth(c.get(format!("{base}{path}")), token)
        .header("Accept", "application/vnd.github+json")
        .query(query)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    check(resp)
        .await?
        .json()
        .await
        .map_err(|e| format!("invalid JSON from GitHub: {e}"))
}

/// The configured account's login — used by the Services "try now" check.
pub async fn whoami(base: &str, token: &str) -> Result<String, String> {
    let v = get_json(base, token, "/user", &[]).await?;
    Ok(v.get("login")
        .and_then(|l| l.as_str())
        .unwrap_or("?")
        .to_string())
}

/// The repo's default branch (used when the caller omits a branch/ref).
async fn default_branch(base: &str, token: &str, owner: &str, repo: &str) -> Result<String, String> {
    let v = get_json(base, token, &format!("/repos/{}/{}", enc(owner), enc(repo)), &[]).await?;
    Ok(v.get("default_branch")
        .and_then(|b| b.as_str())
        .unwrap_or("main")
        .to_string())
}

// ── Field projections (keep tool results compact) ────────────────────────────

fn slim_repo(r: &Value) -> Value {
    json!({
        "full_name": r.get("full_name"),
        "private": r.get("private"),
        "description": r.get("description"),
        "default_branch": r.get("default_branch"),
        "language": r.get("language"),
        "html_url": r.get("html_url"),
        "updated_at": r.get("updated_at"),
    })
}

// ── Read tools ───────────────────────────────────────────────────────────────

pub async fn list_repos(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let per_page = args.get("per_page").and_then(|v| v.as_i64()).unwrap_or(30).clamp(1, 100);
    let sort = opt_string(args, "sort")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "updated".to_string());
    let v = get_json(
        &base,
        &token,
        "/user/repos",
        &[("per_page", per_page.to_string()), ("sort", sort)],
    )
    .await?;
    let repos: Vec<Value> = v.as_array().map(|a| a.iter().map(slim_repo).collect()).unwrap_or_default();
    Ok(json!({ "count": repos.len(), "repos": repos }))
}

pub async fn search_repos(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let query = req_str(args, "query")?;
    let per_page = args.get("per_page").and_then(|v| v.as_i64()).unwrap_or(10).clamp(1, 50);
    let v = get_json(
        &base,
        &token,
        "/search/repositories",
        &[("q", query), ("per_page", per_page.to_string())],
    )
    .await?;
    let items: Vec<Value> = v
        .get("items")
        .and_then(|i| i.as_array())
        .map(|a| a.iter().map(slim_repo).collect())
        .unwrap_or_default();
    Ok(json!({
        "total_count": v.get("total_count"),
        "count": items.len(),
        "repos": items
    }))
}

pub async fn read_file(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let path = req_str(args, "path")?;
    let git_ref = opt_string(args, "ref").filter(|s| !s.trim().is_empty());

    let url = format!(
        "{base}/repos/{}/{}/contents/{}",
        enc(&owner),
        enc(&repo),
        enc_path(&path)
    );
    let c = client()?;
    let mut rb = auth(c.get(&url), &token).header("Accept", "application/vnd.github.raw");
    if let Some(r) = &git_ref {
        rb = rb.query(&[("ref", r.as_str())]);
    }
    let resp = rb.send().await.map_err(|e| format!("request failed: {e}"))?;
    let resp = check(resp).await?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    let truncated = text.len() > MAX_TEXT;
    let mut text = text;
    if truncated {
        text.truncate(MAX_TEXT);
    }
    Ok(json!({
        "owner": owner,
        "repo": repo,
        "path": path,
        "ref": git_ref,
        "truncated": truncated,
        "content": text
    }))
}

pub async fn list_dir(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let path = opt_string(args, "path").unwrap_or_default();
    let git_ref = opt_string(args, "ref").filter(|s| !s.trim().is_empty());

    let endpoint = format!(
        "/repos/{}/{}/contents/{}",
        enc(&owner),
        enc(&repo),
        enc_path(&path)
    );
    let query: Vec<(&str, String)> = git_ref.iter().map(|r| ("ref", r.clone())).collect();
    let v = get_json(&base, &token, &endpoint, &query).await?;
    let entries: Vec<Value> = match v.as_array() {
        Some(a) => a
            .iter()
            .map(|e| {
                json!({
                    "name": e.get("name"),
                    "path": e.get("path"),
                    "type": e.get("type"),
                    "size": e.get("size"),
                })
            })
            .collect(),
        None => return Err("that path is a file, not a directory — use github_read_file".into()),
    };
    Ok(json!({ "path": path, "count": entries.len(), "entries": entries }))
}

pub async fn list_commits(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(10).clamp(1, 30);
    let mut query = vec![("per_page", limit.to_string())];
    if let Some(b) = opt_string(args, "branch").filter(|s| !s.trim().is_empty()) {
        query.push(("sha", b));
    }
    if let Some(p) = opt_string(args, "path").filter(|s| !s.trim().is_empty()) {
        query.push(("path", p));
    }
    let v = get_json(
        &base,
        &token,
        &format!("/repos/{}/{}/commits", enc(&owner), enc(&repo)),
        &query,
    )
    .await?;
    let commits: Vec<Value> = v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| {
                    let commit = c.get("commit");
                    let full_msg = commit
                        .and_then(|m| m.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("");
                    json!({
                        "sha": c.get("sha"),
                        "message": full_msg.lines().next().unwrap_or(""),
                        "author": commit.and_then(|m| m.get("author")).and_then(|a| a.get("name")),
                        "date": commit.and_then(|m| m.get("author")).and_then(|a| a.get("date")),
                        "html_url": c.get("html_url"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "count": commits.len(), "commits": commits }))
}

pub async fn list_branches(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let per_page = args.get("per_page").and_then(|v| v.as_i64()).unwrap_or(30).clamp(1, 100);
    let v = get_json(
        &base,
        &token,
        &format!("/repos/{}/{}/branches", enc(&owner), enc(&repo)),
        &[("per_page", per_page.to_string())],
    )
    .await?;
    let branches: Vec<Value> = v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|b| {
                    json!({
                        "name": b.get("name"),
                        "sha": b.get("commit").and_then(|c| c.get("sha")),
                        "protected": b.get("protected"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "count": branches.len(), "branches": branches }))
}

fn slim_issue(i: &Value) -> Value {
    json!({
        "number": i.get("number"),
        "title": i.get("title"),
        "state": i.get("state"),
        "user": i.get("user").and_then(|u| u.get("login")),
        "comments": i.get("comments"),
        "html_url": i.get("html_url"),
        "updated_at": i.get("updated_at"),
    })
}

pub async fn list_issues(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let state = opt_string(args, "state")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "open".to_string());
    let per_page = args.get("per_page").and_then(|v| v.as_i64()).unwrap_or(20).clamp(1, 50);
    let v = get_json(
        &base,
        &token,
        &format!("/repos/{}/{}/issues", enc(&owner), enc(&repo)),
        &[("state", state), ("per_page", per_page.to_string())],
    )
    .await?;
    // The issues endpoint also returns PRs; drop anything with `pull_request`.
    let issues: Vec<Value> = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|i| i.get("pull_request").is_none())
                .map(slim_issue)
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "count": issues.len(), "issues": issues }))
}

pub async fn list_prs(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let state = opt_string(args, "state")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "open".to_string());
    let per_page = args.get("per_page").and_then(|v| v.as_i64()).unwrap_or(20).clamp(1, 50);
    let v = get_json(
        &base,
        &token,
        &format!("/repos/{}/{}/pulls", enc(&owner), enc(&repo)),
        &[("state", state), ("per_page", per_page.to_string())],
    )
    .await?;
    let prs: Vec<Value> = v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|p| {
                    json!({
                        "number": p.get("number"),
                        "title": p.get("title"),
                        "state": p.get("state"),
                        "user": p.get("user").and_then(|u| u.get("login")),
                        "head": p.get("head").and_then(|h| h.get("ref")),
                        "base": p.get("base").and_then(|b| b.get("ref")),
                        "draft": p.get("draft"),
                        "html_url": p.get("html_url"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "count": prs.len(), "prs": prs }))
}

// ── Write tools (additive only) ──────────────────────────────────────────────

pub async fn create_or_update_file(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let path = req_str(args, "path")?;
    let content = req_str(args, "content")?;
    let message = req_str(args, "message")?;
    let branch = match opt_string(args, "branch").filter(|s| !s.trim().is_empty()) {
        Some(b) => b,
        None => default_branch(&base, &token, &owner, &repo).await?,
    };

    let url = format!(
        "{base}/repos/{}/{}/contents/{}",
        enc(&owner),
        enc(&repo),
        enc_path(&path)
    );

    // Look up the existing blob sha (required for an update; absent = create).
    let existing_sha: Option<String> = {
        let v = get_json(
            &base,
            &token,
            &format!(
                "/repos/{}/{}/contents/{}",
                enc(&owner),
                enc(&repo),
                enc_path(&path)
            ),
            &[("ref", branch.clone())],
        )
        .await;
        match v {
            Ok(val) => val.get("sha").and_then(|s| s.as_str()).map(|s| s.to_string()),
            Err(e) if e.contains("(404)") => None,
            Err(e) => return Err(e),
        }
    };

    let mut body = json!({
        "message": message,
        "content": B64.encode(content.as_bytes()),
        "branch": branch,
    });
    if let Some(sha) = existing_sha {
        body["sha"] = json!(sha);
    }

    let c = client()?;
    let resp = auth(c.put(&url), &token)
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let v: Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "path": path,
        "branch": branch,
        "commit_sha": v.get("commit").and_then(|c| c.get("sha")),
        "html_url": v.get("content").and_then(|c| c.get("html_url")),
    }))
}

pub async fn create_issue(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let title = req_str(args, "title")?;
    let mut body = json!({ "title": title });
    if let Some(b) = opt_string(args, "body").filter(|s| !s.trim().is_empty()) {
        body["body"] = json!(b);
    }
    let c = client()?;
    let resp = auth(
        c.post(format!("{base}/repos/{}/{}/issues", enc(&owner), enc(&repo))),
        &token,
    )
    .header("Accept", "application/vnd.github+json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("request failed: {e}"))?;
    let v: Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "number": v.get("number"),
        "html_url": v.get("html_url"),
    }))
}

pub async fn create_branch(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let new_branch = req_str(args, "new_branch")?;
    let from_branch = match opt_string(args, "from_branch").filter(|s| !s.trim().is_empty()) {
        Some(b) => b,
        None => default_branch(&base, &token, &owner, &repo).await?,
    };

    // Resolve the source branch tip sha.
    let from_ref = get_json(
        &base,
        &token,
        &format!(
            "/repos/{}/{}/git/ref/heads/{}",
            enc(&owner),
            enc(&repo),
            enc(&from_branch)
        ),
        &[],
    )
    .await?;
    let sha = from_ref
        .get("object")
        .and_then(|o| o.get("sha"))
        .and_then(|s| s.as_str())
        .ok_or("could not resolve source branch sha")?
        .to_string();

    let body = json!({ "ref": format!("refs/heads/{new_branch}"), "sha": sha });
    let c = client()?;
    let resp = auth(
        c.post(format!("{base}/repos/{}/{}/git/refs", enc(&owner), enc(&repo))),
        &token,
    )
    .header("Accept", "application/vnd.github+json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("request failed: {e}"))?;
    let v: Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "branch": new_branch,
        "from": from_branch,
        "ref": v.get("ref"),
        "sha": v.get("object").and_then(|o| o.get("sha")),
    }))
}

pub async fn create_pull_request(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let (base, token) = cfg(pool).await?;
    let owner = req_str(args, "owner")?;
    let repo = req_str(args, "repo")?;
    let title = req_str(args, "title")?;
    let head = req_str(args, "head")?;
    let base_branch = match opt_string(args, "base").filter(|s| !s.trim().is_empty()) {
        Some(b) => b,
        None => default_branch(&base, &token, &owner, &repo).await?,
    };
    let mut body = json!({ "title": title, "head": head, "base": base_branch });
    if let Some(b) = opt_string(args, "body").filter(|s| !s.trim().is_empty()) {
        body["body"] = json!(b);
    }
    let c = client()?;
    let resp = auth(
        c.post(format!("{base}/repos/{}/{}/pulls", enc(&owner), enc(&repo))),
        &token,
    )
    .header("Accept", "application/vnd.github+json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("request failed: {e}"))?;
    let v: Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "number": v.get("number"),
        "html_url": v.get("html_url"),
    }))
}
