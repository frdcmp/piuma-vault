import { generateKeyBetween } from "fractional-indexing";

// Fractional-index sort keys (LexoRank-style). The backend stores `rank` as an
// opaque TEXT and orders lexicographically; all key math lives here so the web
// and mobile clients stay the single source of truth.
//
// A key can always be minted strictly between any two neighbours, so reordering
// a task touches exactly one row — no renumbering, ever.

// Key strictly between `before` and `after` (either may be null/undefined for
// the start/end of the list). Used when a task is dropped between two rows.
export function rankBetween(before, after) {
	return generateKeyBetween(before ?? null, after ?? null);
}

// Key that places a new task at the very top of the list (`topRank` = the
// current first task's rank, or null when the list is empty).
export function rankBefore(topRank) {
	return generateKeyBetween(null, topRank ?? null);
}
