//! L1: the agent's profile of the user, in every prompt. It holds what any assistant needs to
//! answer any message from them well, whatever it's about, in three sections, one line per fact:
//!
//!   who        who they are: name, what they do, where they're based, time zone, languages
//!   answers    how they want answers: tone, length, language, format
//!   organised  how their things are organised: where projects, plans and notes live, conventions
//!
//! A line goes under one of them. Kept as markdown in `db_agent_profiles.user_context`, a
//! `## <title>` per section and a `- <line>` per fact, which the user can also edit as text.

/// One section of the profile.
pub struct Section {
    /// what the tools name it
    pub key: &'static str,
    /// its heading in the profile
    pub title: &'static str,
    /// what it holds
    pub holds: &'static str,
}

/// In the order the profile shows them.
pub const SECTIONS: &[Section] = &[
    Section { key: "who", title: "Who they are", holds: "name, what they do, where they're based, time zone, languages" },
    Section { key: "answers", title: "How they want answers", holds: "tone, length, language, format" },
    Section { key: "organised", title: "How their things are organised", holds: "where projects, plans and notes live in the vault; conventions such as the first day of the week" },
];

/// The profile's size, at most (characters).
pub const CAP: usize = 1375;

pub fn section(key: &str) -> Result<&'static Section, String> {
    SECTIONS
        .iter()
        .find(|s| s.key == key)
        .ok_or_else(|| format!("no section '{key}': {}", SECTIONS.iter().map(|s| s.key).collect::<Vec<_>>().join(" | ")))
}

/// The sections as a tool or a prompt describes them: "who — who they are: name, …".
pub fn described() -> String {
    SECTIONS.iter().map(|s| format!("{} — {}: {}", s.key, s.title.to_lowercase(), s.holds)).collect::<Vec<_>>().join("; ")
}

fn heading(s: &Section) -> String {
    format!("## {}", s.title)
}

/// The profile with `line` added under its section: after the section's last line, or as a new
/// section placed in the sections' order.
pub fn with_line(profile: &str, s: &Section, line: &str) -> String {
    let mut lines: Vec<String> = profile.lines().map(str::to_string).collect();
    let item = format!("- {}", line.trim().trim_start_matches("- "));
    let is_heading = |l: &str| l.trim_start().starts_with("## ");
    match lines.iter().position(|l| l.trim() == heading(s)) {
        Some(at) => {
            let mut end = lines[at + 1..].iter().position(|l| is_heading(l)).map_or(lines.len(), |i| at + 1 + i);
            while end > at + 1 && lines[end - 1].trim().is_empty() {
                end -= 1;
            }
            lines.insert(end, item);
        }
        None => {
            // before the first section that comes after it, else at the end
            let later: Vec<String> = SECTIONS.iter().skip_while(|o| o.key != s.key).skip(1).map(heading).collect();
            let at = lines.iter().position(|l| later.iter().any(|h| l.trim() == h)).unwrap_or(lines.len());
            let mut block = vec![heading(s), item];
            if at < lines.len() {
                block.push(String::new());
            } else if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                block.insert(0, String::new());
            }
            lines.splice(at..at, block);
        }
    }
    lines.join("\n")
}

/// The profile's facts, each with the section it's under (none: above every section).
pub fn facts(profile: &str) -> Vec<(Option<&'static str>, String)> {
    let mut under = None;
    let mut out = Vec::new();
    for l in profile.lines() {
        let t = l.trim();
        if let Some(title) = t.strip_prefix("## ") {
            under = SECTIONS.iter().find(|s| s.title == title.trim()).map(|s| s.key);
        } else if let Some(fact) = t.strip_prefix("- ") {
            out.push((under, fact.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_goes_under_its_section_and_a_missing_section_takes_its_place() {
        let p = "## Who they are\n- Alex, a teacher.\n\n## How their things are organised\n- Work under /work.";
        let p = with_line(p, section("who").unwrap(), "Speaks English and Spanish.");
        assert_eq!(p, "## Who they are\n- Alex, a teacher.\n- Speaks English and Spanish.\n\n## How their things are organised\n- Work under /work.");
        let p = with_line(&p, section("answers").unwrap(), "- Short answers.");
        assert!(p.contains("- Speaks English and Spanish.\n\n## How they want answers\n- Short answers.\n\n## How their things are organised"));
        assert_eq!(with_line("", section("organised").unwrap(), "Week starts Monday."), "## How their things are organised\n- Week starts Monday.");
        let facts = facts(&p);
        assert_eq!(facts[2], (Some("answers"), "Short answers.".to_string()));
    }
}
