// Reply timing (the backend's `timing`): what a reply's wait comes to, for the
// settings' preview. Seconds from their last message to the reply. The phone
// app has the same (pigeon-mobile src/util/timing.js).

// Pigeon writing the reply, about (the AI, between the wait and the reading).
const WRITING = [5, 15];
// "typing…" goes off between bursts (3–7 s on, 1–2.5 s off): on average this
// much longer than the typing alone.
const BREAKS = 1.35;

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

// [soonest, latest] a reply of `chars` characters lands; `quiet`: the first in
// a quiet chat (no sooner than the quiet chat's landing).
export function landing(t, chars, quiet = false) {
	const typing = (k) => clamp((chars / t.chars_per_sec) * k, t.typing_secs);
	let lo = t.wait_secs + WRITING[0] + t.read_secs[0] + typing(0.75);
	let hi = t.wait_secs + WRITING[1] + t.read_secs[1] + typing(1.25) * BREAKS;
	if (quiet) {
		lo = Math.max(lo, t.cold_secs[0]);
		hi = Math.max(hi, t.cold_secs[1]);
	}
	return [Math.round(lo), Math.round(hi)];
}

// The longest the pacing before a reply can take (the backend's check: within
// `max_pacing`), from the view's `burst_min` and `break_max`.
export function longestPacing(t, view) {
	const typing = t.typing_secs[1] * (1 + view.break_max / view.burst_min);
	return Math.max(t.read_secs[1] + typing, t.cold_secs[1]);
}
