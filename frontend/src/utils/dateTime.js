/**
 * Date-time formatting utilities.
 *
 * All timestamps from the backend are UTC. These helpers convert to the
 * user's browser timezone and produce consistent display strings:
 *
 *   formatDate(v)     →  "02 Apr, 2026"
 *   formatTime(v)     →  "14:00"
 *   formatDateTime(v) →  { date: "02 Apr, 2026", time: "14:00" }
 *   timeAgo(v)        →  "2 hours ago"
 */

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Parse a value (ISO string or Date) as UTC.
 * Appends "Z" when no timezone designator is present so that bare strings
 * from the backend (e.g. "2026-04-24T14:00:00") are treated as UTC.
 *
 * @param {string|Date|null|undefined} value
 * @returns {Date|null}
 */
const parseUtc = (value) => {
	if (!value) return null;
	if (value instanceof Date)
		return Number.isNaN(value.getTime()) ? null : value;
	const s = String(value).trim();
	// Already has timezone info (Z, +HH:mm, -HH:mm)
	const hasOffset = /[Z]$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s);
	const normalized = hasOffset ? s : `${s}Z`;
	const d = new Date(normalized);
	return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Format a UTC value as "02 Apr, 2026" in the browser timezone.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string}
 */
export const formatDate = (value) => {
	const d = parseUtc(value);
	if (!d) return "—";
	const parts = new Intl.DateTimeFormat("en-GB", {
		day: "2-digit",
		month: "short",
		year: "numeric",
		timeZone: TZ,
	}).formatToParts(d);
	const day = parts.find((p) => p.type === "day")?.value ?? "";
	const month = parts.find((p) => p.type === "month")?.value ?? "";
	const year = parts.find((p) => p.type === "year")?.value ?? "";
	return `${day} ${month}, ${year}`;
};

/**
 * Format a UTC value as "14:00" (24-hour, browser timezone).
 *
 * @param {string|Date|null|undefined} value
 * @returns {string}
 */
export const formatTime = (value) => {
	const d = parseUtc(value);
	if (!d) return "—";
	const parts = new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZone: TZ,
	}).formatToParts(d);
	const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
	const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
	return `${hour}:${minute}`;
};

/**
 * Format a UTC value as both date and time in the browser timezone.
 * Returns an object with `date` and `time` properties for flexible rendering.
 *
 * @param {string|Date|null|undefined} value
 * @returns {{ date: string, time: string }}
 *
 * @example
 * const { date, time } = formatDateTime(record.created_at);
 * // <><div>{date}</div><div>{time}</div></>
 */
export const formatDateTime = (value) => {
	return {
		date: formatDate(value),
		time: formatTime(value),
	};
};

/**
 * Relative time from a UTC value (e.g. "2 hours ago", "in 5 minutes").
 * Uses the browser locale for natural-language output.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string}
 */
export const timeAgo = (value) => {
	const d = parseUtc(value);
	if (!d) return "—";
	const diffMs = d.getTime() - Date.now();
	const diffSec = Math.round(diffMs / 1000);
	const abs = Math.abs(diffSec);
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (abs < 60) return rtf.format(diffSec, "second");
	if (abs < 3_600) return rtf.format(Math.round(diffSec / 60), "minute");
	if (abs < 86_400) return rtf.format(Math.round(diffSec / 3_600), "hour");
	if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 86_400), "day");
	if (abs < 31_536_000)
		return rtf.format(Math.round(diffSec / 2_592_000), "month");
	return rtf.format(Math.round(diffSec / 31_536_000), "year");
};
