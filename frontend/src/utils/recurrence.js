/**
 * Recurrence expansion (RFC-5545 subset) — anchored to the user's LOCAL
 * calendar, per the Calendar & Tasks plan.
 *
 * The backend stores recurring-task templates as an `rrule` string + UTC
 * `dtstart`; it does not expand them. Expansion happens here (and in the
 * mobile equivalent) using dayjs in the device timezone, so "every Mon/Wed/Fri"
 * means *local* Mon/Wed/Fri and occurrences land on the correct calendar day.
 *
 * Supported rule parts: FREQ (DAILY|WEEKLY|MONTHLY), INTERVAL, BYDAY (for
 * WEEKLY), UNTIL, COUNT. Anything else is ignored gracefully.
 */

import dayjs from "dayjs";

// RFC-5545 weekday tokens → dayjs day-of-week index (0 = Sunday).
const BYDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Hard cap so an open-ended rule with a huge range can never loop forever.
const MAX_OCCURRENCES = 1000;

/**
 * Parse an rrule string ("FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1") into parts.
 * @param {string} rrule
 */
export const parseRrule = (rrule) => {
	const parts = {
		freq: null,
		interval: 1,
		byday: [],
		until: null,
		count: null,
	};
	if (!rrule || typeof rrule !== "string") return parts;
	for (const segment of rrule.split(";")) {
		const [rawKey, rawVal] = segment.split("=");
		if (!rawKey || !rawVal) continue;
		const key = rawKey.trim().toUpperCase();
		const val = rawVal.trim();
		switch (key) {
			case "FREQ":
				parts.freq = val.toUpperCase();
				break;
			case "INTERVAL": {
				const n = Number.parseInt(val, 10);
				if (Number.isFinite(n) && n > 0) parts.interval = n;
				break;
			}
			case "BYDAY":
				parts.byday = val
					.toUpperCase()
					.split(",")
					.map((d) => BYDAY_INDEX[d.trim()])
					.filter((i) => i !== undefined);
				break;
			case "UNTIL":
				parts.until = dayjs(val);
				break;
			case "COUNT": {
				const n = Number.parseInt(val, 10);
				if (Number.isFinite(n) && n > 0) parts.count = n;
				break;
			}
			default:
				break;
		}
	}
	return parts;
};

/**
 * Expand a recurrence into the local-date occurrences that fall within
 * [rangeStart, rangeEnd]. Each occurrence keeps the template's local time-of-day.
 *
 * @param {object} args
 * @param {string} args.rrule       RFC-5545 rule string
 * @param {string|Date} args.dtstart  UTC anchor (ISO string from backend)
 * @param {string|Date} args.rangeStart  visible window start
 * @param {string|Date} args.rangeEnd    visible window end
 * @param {string|Date|null} [args.until]  optional hard end (template.until)
 * @returns {Array<{ date: string, at: dayjs.Dayjs }>}  date = "YYYY-MM-DD" (local)
 */
export const expandRecurrence = ({
	rrule,
	dtstart,
	rangeStart,
	rangeEnd,
	until,
}) => {
	const rule = parseRrule(rrule);
	if (!rule.freq) return [];

	const start = dayjs(dtstart); // local representation of the UTC anchor
	if (!start.isValid()) return [];

	const windowStart = dayjs(rangeStart).startOf("day");
	const windowEnd = dayjs(rangeEnd).endOf("day");
	const hardUntil = until ? dayjs(until) : rule.until;

	// Iterate from `start`, never below the window, and stop at window/until/count.
	const out = [];
	let produced = 0;
	const hour = start.hour();
	const minute = start.minute();

	const withinHardLimits = (d) => {
		if (hardUntil?.isValid() && d.isAfter(hardUntil)) return false;
		if (rule.count != null && produced >= rule.count) return false;
		return true;
	};

	const push = (d) => {
		if (d.isBefore(windowStart) || d.isAfter(windowEnd)) return true; // keep walking
		out.push({ date: d.format("YYYY-MM-DD"), at: d });
		return true;
	};

	if (rule.freq === "WEEKLY") {
		const days = rule.byday.length ? rule.byday : [start.day()];
		// Walk week by week from the week containing `start`. Anchor on the Sunday
		// via `.day(0)` (pure Sunday-based arithmetic) rather than `startOf("week")`
		// so `weekAnchor.day(dow)` resolves each BYDAY token correctly regardless of
		// the global Monday week-start (see utils/dayjsConfig.js).
		let weekAnchor = start.day(0);
		let guard = 0;
		while (guard++ < MAX_OCCURRENCES * 2) {
			for (const dow of days) {
				const occ = weekAnchor.day(dow).hour(hour).minute(minute).second(0);
				if (occ.isBefore(start, "day")) continue; // before the template start
				if (!withinHardLimits(occ)) return out;
				produced += 1;
				push(occ);
				if (rule.count != null && produced >= rule.count) return out;
			}
			weekAnchor = weekAnchor.add(7 * rule.interval, "day");
			if (weekAnchor.isAfter(windowEnd) && weekAnchor.isAfter(start)) break;
			if (out.length >= MAX_OCCURRENCES) break;
		}
		return out;
	}

	// DAILY / MONTHLY: single step per interval from `start`.
	const stepUnit = rule.freq === "MONTHLY" ? "month" : "day";
	let cursor = start.hour(hour).minute(minute).second(0);
	let guard = 0;
	while (guard++ < MAX_OCCURRENCES) {
		if (!withinHardLimits(cursor)) break;
		if (cursor.isAfter(windowEnd)) break;
		produced += 1;
		push(cursor);
		cursor = cursor.add(rule.interval, stepUnit);
		if (out.length >= MAX_OCCURRENCES) break;
	}
	return out;
};
