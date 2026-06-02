//! Server-side recurrence expansion (RFC-5545 subset), mirroring
//! `frontend/src/utils/recurrence.js` so the agenda endpoint can hand a
//! third-party agent the concrete recurring-task occurrences for a date range
//! in a single call — instead of returning bare rrule templates the caller
//! would have to expand itself.
//!
//! Expansion is done in **UTC** (dates only). The clients expand in the device
//! local timezone; for an API consumer the simplest precise contract is "pass a
//! UTC window, get UTC occurrence dates back". Supported parts: FREQ
//! (DAILY|WEEKLY|MONTHLY), INTERVAL, BYDAY (WEEKLY), UNTIL, COUNT.

use chrono::{DateTime, Datelike, Duration, Months, NaiveDate, NaiveDateTime, Utc};

// Hard cap so an open-ended rule with a huge range can never loop forever.
const MAX_OCCURRENCES: usize = 1000;

struct Rrule {
    freq: Option<String>,
    interval: u32,
    byday: Vec<u32>, // 0 = Sunday .. 6 = Saturday
    until: Option<NaiveDate>,
    count: Option<usize>,
}

// RFC-5545 weekday token → 0=Sun..6=Sat (matches chrono's num_days_from_sunday).
fn byday_index(tok: &str) -> Option<u32> {
    match tok.trim().to_uppercase().as_str() {
        "SU" => Some(0),
        "MO" => Some(1),
        "TU" => Some(2),
        "WE" => Some(3),
        "TH" => Some(4),
        "FR" => Some(5),
        "SA" => Some(6),
        _ => None,
    }
}

// UNTIL may be a date ("20261231"), a UTC datetime ("20261231T235959Z"), or an
// RFC-3339 instant. Reduce any of them to a UTC date.
fn parse_until(val: &str) -> Option<NaiveDate> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(val) {
        return Some(dt.naive_utc().date());
    }
    for fmt in ["%Y%m%dT%H%M%SZ", "%Y%m%dT%H%M%S"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(val, fmt) {
            return Some(dt.date());
        }
    }
    for fmt in ["%Y-%m-%d", "%Y%m%d"] {
        if let Ok(d) = NaiveDate::parse_from_str(val, fmt) {
            return Some(d);
        }
    }
    None
}

fn parse_rrule(s: &str) -> Rrule {
    let mut r = Rrule {
        freq: None,
        interval: 1,
        byday: Vec::new(),
        until: None,
        count: None,
    };
    for segment in s.split(';') {
        let mut it = segment.splitn(2, '=');
        let key = it.next().unwrap_or("").trim().to_uppercase();
        let val = match it.next() {
            Some(v) => v.trim(),
            None => continue,
        };
        match key.as_str() {
            "FREQ" => r.freq = Some(val.to_uppercase()),
            "INTERVAL" => {
                if let Ok(n) = val.parse::<u32>() {
                    if n > 0 {
                        r.interval = n;
                    }
                }
            }
            "BYDAY" => r.byday = val.split(',').filter_map(byday_index).collect(),
            "UNTIL" => r.until = parse_until(val),
            "COUNT" => {
                if let Ok(n) = val.parse::<usize>() {
                    if n > 0 {
                        r.count = Some(n);
                    }
                }
            }
            _ => {}
        }
    }
    r
}

/// Expand a recurrence into the UTC dates that fall within
/// `[range_start, range_end]` (inclusive). `until` is the template's hard end,
/// which combines with any `UNTIL=` inside the rule (the earlier one wins).
pub fn expand_dates(
    rrule: &str,
    dtstart: DateTime<Utc>,
    until: Option<DateTime<Utc>>,
    range_start: NaiveDate,
    range_end: NaiveDate,
) -> Vec<NaiveDate> {
    let rule = parse_rrule(rrule);
    let Some(freq) = rule.freq.as_deref() else {
        return Vec::new();
    };

    let start = dtstart.date_naive();
    let hard_until = match (until.map(|u| u.date_naive()), rule.until) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    let count = rule.count;

    let within_hard = |d: NaiveDate, produced: usize| -> bool {
        if let Some(hu) = hard_until {
            if d > hu {
                return false;
            }
        }
        if let Some(c) = count {
            if produced >= c {
                return false;
            }
        }
        true
    };

    let mut out: Vec<NaiveDate> = Vec::new();
    let mut produced: usize = 0;

    if freq == "WEEKLY" {
        let mut days = if rule.byday.is_empty() {
            vec![start.weekday().num_days_from_sunday()]
        } else {
            rule.byday.clone()
        };
        days.sort_unstable();
        days.dedup();

        // Week anchor = Sunday of the week containing `start` (dayjs default).
        let mut week_anchor = start - Duration::days(start.weekday().num_days_from_sunday() as i64);
        let mut guard = 0;
        while guard < MAX_OCCURRENCES * 2 {
            guard += 1;
            for &dow in &days {
                let occ = week_anchor + Duration::days(dow as i64);
                if occ < start {
                    continue; // before the template start
                }
                if !within_hard(occ, produced) {
                    return out;
                }
                produced += 1;
                if occ >= range_start && occ <= range_end {
                    out.push(occ);
                }
                if let Some(c) = count {
                    if produced >= c {
                        return out;
                    }
                }
            }
            week_anchor += Duration::days(7 * rule.interval as i64);
            if week_anchor > range_end && week_anchor > start {
                break;
            }
            if out.len() >= MAX_OCCURRENCES {
                break;
            }
        }
        return out;
    }

    // DAILY / MONTHLY: single step per interval from `start`.
    let mut cursor = start;
    let mut guard = 0;
    while guard < MAX_OCCURRENCES {
        guard += 1;
        if !within_hard(cursor, produced) {
            break;
        }
        if cursor > range_end {
            break;
        }
        produced += 1;
        if cursor >= range_start {
            out.push(cursor);
        }
        cursor = if freq == "MONTHLY" {
            match cursor.checked_add_months(Months::new(rule.interval)) {
                Some(d) => d,
                None => break,
            }
        } else {
            cursor + Duration::days(rule.interval as i64)
        };
        if out.len() >= MAX_OCCURRENCES {
            break;
        }
    }
    out
}
