//! Jev, the classifier (`POST {PIGEON_JEV_URL}/systemone`): it answers `noul` (yes/no), `choice`
//! (pick one) and `score` questions about a `state`, with probabilities, and never writes text.
//! One endpoint, no fallback chain (a gateway in front of it is where failing over belongs).

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Map, Value as Json};

use crate::apps::pigeon::config::JevConf;

/// The questions one request carries (OpenCode Zen takes 40).
const MAX_QUESTIONS: usize = 40;

#[derive(Clone)]
pub struct Jev {
    url: String,
    api_key: String,
    pub model: String,
    http: reqwest::Client,
}

/// A yes/no question: the answer is P(yes).
pub fn noul(instructions: &str) -> Json {
    json!({ "type": "noul", "instructions": instructions })
}

/// Pick one: `criteria` is key → what it means (or null when the key speaks for itself).
/// The questions as asked for one user: "{me}" in them becomes their name.
pub fn for_user(questions: &mut Map<String, Json>, name: &str) {
    fn walk(v: &mut Json, name: &str) {
        match v {
            Json::String(s) if s.contains("{me}") => *s = s.replace("{me}", name),
            Json::Array(a) => a.iter_mut().for_each(|v| walk(v, name)),
            Json::Object(o) => o.values_mut().for_each(|v| walk(v, name)),
            _ => {}
        }
    }
    questions.values_mut().for_each(|v| walk(v, name));
}

pub fn choice(instructions: &str, options: &[(&str, Option<&str>)]) -> Json {
    let criteria: Map<String, Json> = options.iter().map(|(k, d)| (k.to_string(), d.map(Json::from).unwrap_or(Json::Null))).collect();
    json!({ "type": "choice", "instructions": instructions, "criteria": criteria })
}

/// A scale, lowest first: the answer is a (fractional) index into it.
pub fn score(instructions: &str, scale: &[&str]) -> Json {
    json!({ "type": "score", "instructions": instructions, "criteria": scale })
}

impl Jev {
    pub fn new(cfg: &JevConf) -> Jev {
        Jev {
            url: format!("{}/systemone", cfg.url),
            api_key: cfg.api_key.clone(),
            model: cfg.model.clone(),
            http: reqwest::Client::builder().timeout(Duration::from_secs(30)).user_agent("piuma-vault-pigeon/1").build().expect("reqwest client"),
        }
    }

    /// Every question about `state`, in batches of MAX_QUESTIONS; the answers come back together,
    /// by question name.
    pub async fn ask(&self, state: &Json, questions: Map<String, Json>) -> anyhow::Result<Answers> {
        let items: Vec<(String, Json)> = questions.into_iter().collect();
        let mut answers = HashMap::new();
        let mut raw = Map::new();
        for chunk in items.chunks(MAX_QUESTIONS) {
            let batch: Map<String, Json> = chunk.iter().cloned().collect();
            let body = json!({ "model": self.model, "state": state, "questions": batch });
            let res = self
                .http
                .post(&self.url)
                .bearer_auth(&self.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| anyhow::anyhow!("Jev unreachable: {e}"))?;
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            if !status.is_success() {
                anyhow::bail!("Jev request failed ({}): {}", status.as_u16(), text.chars().take(300).collect::<String>());
            }
            let body: Json = serde_json::from_str(&text).map_err(|_| anyhow::anyhow!("Jev returned malformed JSON"))?;
            let got = body.get("answers").and_then(Json::as_object).ok_or_else(|| anyhow::anyhow!("Jev's answer has no `answers`"))?;
            for (k, a) in got {
                raw.insert(k.clone(), a.clone());
                answers.insert(k.clone(), normalise(a));
            }
        }
        Ok(Answers { answers, raw: Json::Object(raw) })
    }
}

/// One answer in one shape: a `noul` may come as `{"noul": p}` or a bare number.
fn normalise(a: &Json) -> Json {
    if let Some(n) = a.as_f64() {
        return json!({ "noul": n });
    }
    a.clone()
}

pub struct Answers {
    answers: HashMap<String, Json>,
    /// What Jev sent, whole: stored with the triage so thresholds can be re-tuned.
    pub raw: Json,
}

impl Answers {
    /// P(yes) of a `noul` question.
    pub fn yes(&self, name: &str) -> Option<f64> {
        self.answers.get(name)?.get("noul")?.as_f64()
    }

    /// The picked option of a `choice` question, with its probability.
    pub fn choice(&self, name: &str) -> Option<(String, f64)> {
        let a = self.answers.get(name)?;
        let pick = a.get("choice")?.as_str()?.to_string();
        let p = a.get("probabilities").and_then(|p| p.get(&pick)).and_then(Json::as_f64).unwrap_or(0.0);
        Some((pick, p))
    }

    /// A `score` answer, as a fraction of its scale (0 = the lowest step, 1 = the highest).
    pub fn score_fraction(&self, name: &str, steps: usize) -> Option<f64> {
        let s = self.answers.get(name)?.get("score")?.as_f64()?;
        Some(if steps > 1 { (s / (steps - 1) as f64).clamp(0.0, 1.0) } else { 0.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_answer_shapes() {
        let mut answers = HashMap::new();
        answers.insert("a".to_string(), normalise(&json!(0.9)));
        answers.insert("b".to_string(), normalise(&json!({"noul": 0.2, "type": "noul"})));
        answers.insert("c".to_string(), json!({"choice": "money", "probabilities": {"money": 0.6, "request": 0.4}}));
        answers.insert("d".to_string(), json!({"score": 1.5, "legend": {"0": "low"}}));
        let a = Answers { answers, raw: Json::Null };
        assert_eq!(a.yes("a"), Some(0.9));
        assert_eq!(a.yes("b"), Some(0.2));
        assert_eq!(a.choice("c"), Some(("money".into(), 0.6)));
        assert_eq!(a.score_fraction("d", 3), Some(0.75));
        assert_eq!(a.yes("missing"), None);
    }
}
