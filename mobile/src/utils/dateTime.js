// Date/time formatting for mobile. Mirrors frontend/src/utils/dateTime.js so
// web and mobile render dates identically. Backend timestamps are UTC; we
// convert to the device timezone.
//
// IMPORTANT: this is formatted with dayjs, NOT Intl. Release Android builds run
// on Hermes, whose Intl only implements Collator/DateTimeFormat/NumberFormat —
// `Intl.RelativeTimeFormat` is UNDEFINED there, so `new Intl.RelativeTimeFormat()`
// throws "Cannot read property 'prototype' of undefined" and crashes the screen
// (Tasks was the only screen calling timeAgo). dayjs is pure JS and already a
// dependency, so it works everywhere; it also renders in the device-local
// timezone automatically.

import dayjs from "dayjs";

// Append "Z" to bare strings (e.g. "2026-04-24T14:00:00") so they're parsed
// as UTC rather than local time. Returns a dayjs instance or null.
const parseUtc = (value) => {
	if (!value) return null;
	if (value instanceof Date) {
		const d = dayjs(value);
		return d.isValid() ? d : null;
	}
	const s = String(value).trim();
	const hasOffset = /[Z]$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s);
	const d = dayjs(hasOffset ? s : `${s}Z`);
	return d.isValid() ? d : null;
};

export const formatDate = (value) => {
	const d = parseUtc(value);
	return d ? d.format("DD MMM, YYYY") : "—";
};

export const formatTime = (value) => {
	const d = parseUtc(value);
	return d ? d.format("HH:mm") : "—";
};

export const formatDateTime = (value) => ({
	date: formatDate(value),
	time: formatTime(value),
});

// Relative time ("in 4 hours", "3 days ago"). Hand-rolled so it needs no Intl
// and no dayjs plugin — matches the web's en-GB phrasing closely enough.
export const timeAgo = (value) => {
	const d = parseUtc(value);
	if (!d) return "—";
	const diffSec = Math.round((d.valueOf() - Date.now()) / 1000);
	const future = diffSec >= 0;
	const abs = Math.abs(diffSec);
	const phrase = (n, unit) => {
		const u = n === 1 ? unit : `${unit}s`;
		return future ? `in ${n} ${u}` : `${n} ${u} ago`;
	};
	if (abs < 45) return future ? "in a few seconds" : "a few seconds ago";
	if (abs < 3_600) return phrase(Math.round(abs / 60), "minute");
	if (abs < 86_400) return phrase(Math.round(abs / 3_600), "hour");
	if (abs < 2_592_000) return phrase(Math.round(abs / 86_400), "day");
	if (abs < 31_536_000) return phrase(Math.round(abs / 2_592_000), "month");
	return phrase(Math.round(abs / 31_536_000), "year");
};
