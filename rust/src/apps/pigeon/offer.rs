//! What Pigeon may tell or do for the people who write: the catalogue. Each thing is a tool
//! (`Tool`: the user's place, their calendar, their flights, something they left for someone), with its levels
//! (how much: a country, a city, the exact spot), least first. A permission is one name,
//! `tool.level.mode`, held by a person, a chat or a group (`access`): the mode is `ask` (Pigeon
//! prepares it, the user taps) or `auto` (Pigeon does it and tells them). `auto` includes `ask`, a
//! level includes the ones under it, and `*` stands for any part (`location.*.ask`, `*.*.*`).
//!
//! The names live here, in code, and nowhere else: no table lists them, and the apps draw their
//! screens from `catalogue()` (they know no tool by name); what each tool answers with, at a
//! level, is `tell`. A tool that renames a permission lists
//! the old name in `WAS`: grants written with it keep working, and are rewritten at the worker's
//! start (`access::renames`).

use serde_json::{json, Value as Json};

/// How much of a tool: `name` is what a permission stores, the rest is for the screens.
#[derive(Debug)]
pub struct Level {
    pub name: &'static str,
    pub label: &'static str,
    /// what an answer at this level sounds like
    pub example: &'static str,
}

#[derive(Debug)]
pub struct Tool {
    /// what a permission stores
    pub name: &'static str,
    pub label: &'static str,
    /// what it gives, after "Pigeon may tell them …" / "… asks for"
    pub gives: &'static str,
    /// Jev's yes/no about the new messages, in triage (`{me}`: the user's name)
    pub asks: &'static str,
    /// least first
    pub levels: &'static [Level],
    /// never on its own, whatever the grant says
    pub ask_only: bool,
    /// Pigeon uses it today (false: it can be granted, nothing runs on it yet)
    pub live: bool,
    /// its fact ages: older than this many minutes, Pigeon only drafts with it
    pub fresh: Option<i64>,
}

const USE: &[Level] = &[Level { name: "use", label: "Yes", example: "" }];

pub static TOOLS: &[Tool] = &[
    Tool {
        name: "location",
        label: "Place",
        gives: "where you are right now",
        asks: "Do the new messages ask where {me} is right now, or for {me}'s location?",
        levels: &[
            Level { name: "country", label: "Country", example: "“I'm in Japan”" },
            Level { name: "city", label: "City", example: "“I'm in Tokyo”" },
            Level { name: "area", label: "Area", example: "“I'm in Shibuya, Tokyo”" },
            Level { name: "exact", label: "Exact spot", example: "the street, or a pin on the map" },
        ],
        ask_only: false,
        live: true,
        fresh: Some(30),
    },
    Tool {
        name: "calendar",
        label: "Calendar",
        gives: "whether you're free",
        asks: "Do the new messages ask whether {me} is free or busy at some time, or when {me} is free?",
        levels: &[
            Level { name: "busy", label: "Free or busy", example: "“I'm busy then”" },
            Level { name: "times", label: "The times", example: "“I'm busy until 6, free after”" },
            Level { name: "details", label: "What it is", example: "“I have a dinner until 9”" },
        ],
        ask_only: false,
        live: true,
        fresh: None,
    },
    Tool {
        name: "flights",
        label: "Flights",
        gives: "when you are flying",
        asks: "Do the new messages ask about {me}'s flights: when {me} flies, takes off or lands, or which flight {me} is on?",
        levels: USE,
        ask_only: false,
        live: true,
        fresh: None,
    },
    Tool {
        name: "passon",
        label: "Pass-ons",
        gives: "what you left for them to hear when they ask",
        asks: "",
        levels: USE,
        ask_only: false,
        live: true,
        fresh: None,
    },
];

/// Old permission names and what they are now: `("place.city.auto", "location.city.auto")`.
pub const WAS: &[(&str, &str)] = &[];

pub const MODES: &[&str] = &["ask", "auto"];

pub fn find(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}

impl Tool {
    pub fn level(&self, name: &str) -> Option<usize> {
        self.levels.iter().position(|l| l.name == name)
    }

    /// Whether it has more than yes or no.
    pub fn has_levels(&self) -> bool {
        self.levels.len() > 1
    }
}

/// One permission: `tool.level.mode`, each part a name or `*`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permission {
    pub tool: String,
    pub level: String,
    pub mode: String,
}

impl Permission {
    /// A stored name, as it reads today (an old name is its new one); none: not three parts.
    pub fn read(name: &str) -> Option<Permission> {
        let name = name.trim();
        let name = WAS.iter().find(|(old, _)| *old == name).map(|(_, new)| *new).unwrap_or(name);
        let mut parts = name.split('.');
        let (tool, level, mode) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || [tool, level, mode].iter().any(|p| p.is_empty()) {
            return None;
        }
        Some(Permission { tool: tool.to_string(), level: level.to_string(), mode: mode.to_string() })
    }

    /// A name someone gives now: it must be one the catalogue lists.
    pub fn parse(name: &str) -> anyhow::Result<Permission> {
        let p = Permission::read(&name.to_lowercase()).ok_or_else(|| anyhow::anyhow!("a permission is tool.level.mode (location.city.auto), not {name}"))?;
        if p.mode != "*" && !MODES.contains(&p.mode.as_str()) {
            anyhow::bail!("the mode is ask or auto, not {}", p.mode);
        }
        if p.tool == "*" {
            if p.level != "*" {
                anyhow::bail!("every tool has its own levels: with * for the tool, the level is * too");
            }
            return Ok(p);
        }
        let tool = find(&p.tool).ok_or_else(|| anyhow::anyhow!("no tool {}: {}", p.tool, TOOLS.iter().map(|t| t.name).collect::<Vec<_>>().join(", ")))?;
        if p.level != "*" && tool.level(&p.level).is_none() {
            anyhow::bail!("{}'s levels: {}", tool.name, tool.levels.iter().map(|l| l.name).collect::<Vec<_>>().join(", "));
        }
        if tool.ask_only && p.mode != "ask" {
            anyhow::bail!("{} only asks for now: {}.{}.ask", tool.label, tool.name, p.level);
        }
        Ok(p)
    }

    pub fn name(&self) -> String {
        format!("{}.{}.{}", self.tool, self.level, self.mode)
    }

    pub fn auto(&self) -> bool {
        self.mode != "ask"
    }

    /// Whether some tool still lists it.
    pub fn known(&self) -> bool {
        (self.mode == "*" || MODES.contains(&self.mode.as_str()))
            && match find(&self.tool) {
                Some(t) => self.level == "*" || t.level(&self.level).is_some(),
                None => self.tool == "*" && self.level == "*",
            }
    }

    /// What it comes to for one tool: up to which level (an index into the tool's), and whether
    /// on its own. None: it isn't about this tool (or names a level the tool no longer has).
    pub fn reach(&self, tool: &Tool) -> Option<(usize, bool)> {
        if self.tool != "*" && self.tool != tool.name {
            return None;
        }
        let level = if self.level == "*" { tool.levels.len().checked_sub(1)? } else { tool.level(&self.level)? };
        Some((level, self.auto() && !tool.ask_only))
    }

    /// For the screens: the tool and level it names, in words.
    pub fn view(&self) -> Json {
        let tool = find(&self.tool);
        let level = tool.and_then(|t| t.level(&self.level).map(|i| &t.levels[i]));
        json!({
            "permission": self.name(),
            "tool": self.tool,
            "label": match (tool, self.tool.as_str()) { (Some(t), _) => t.label, (None, "*") => "Everything", _ => self.tool.as_str() },
            "level": self.level,
            "level_label": match (level, self.level.as_str()) { (Some(l), _) => l.label, (None, "*") => "All of it", _ => self.level.as_str() },
            "has_levels": tool.is_none_or(Tool::has_levels),
            "mode": if self.auto() { "auto" } else { "ask" },
            "known": self.known(),
        })
    }
}

/// The catalogue, for the screens and the assistants: every tool, its levels, what each sounds like.
pub fn catalogue() -> Json {
    json!(TOOLS
        .iter()
        .map(|t| json!({
            "tool": t.name,
            "label": t.label,
            "gives": t.gives,
            "levels": t.levels.iter().map(|l| json!({ "name": l.name, "label": l.label, "example": l.example })).collect::<Vec<_>>(),
            "has_levels": t.has_levels(),
            "ask_only": t.ask_only,
            "live": t.live,
            "fresh_minutes": t.fresh,
        }))
        .collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_permission_is_three_parts_the_catalogue_lists() {
        assert_eq!(Permission::parse("Location.City.Auto").unwrap().name(), "location.city.auto");
        assert!(Permission::parse("location.city").is_err());
        assert!(Permission::parse("location.street.ask").is_err());
        assert!(Permission::parse("weather.use.ask").is_err());
        assert!(Permission::parse("location.city.always").is_err());
        assert!(Permission::parse("*.city.ask").is_err());
        assert!(Permission::parse("*.*.ask").is_ok());
        assert!(Permission::parse("location.*.auto").is_ok());
    }

    #[test]
    fn a_level_includes_the_ones_under_it_and_auto_includes_ask() {
        let place = find("location").unwrap();
        assert_eq!(Permission::read("location.city.auto").unwrap().reach(place), Some((1, true)));
        assert_eq!(Permission::read("location.*.ask").unwrap().reach(place), Some((3, false)));
        assert_eq!(Permission::read("*.*.*").unwrap().reach(place), Some((3, true)));
        assert_eq!(Permission::read("calendar.busy.auto").unwrap().reach(place), None);
        // a level the tool dropped matches nothing, and the screen marks it
        let gone = Permission::read("location.planet.auto").unwrap();
        assert_eq!(gone.reach(place), None);
        assert!(!gone.known());
    }
}
