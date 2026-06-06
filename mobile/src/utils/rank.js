import { generateKeyBetween } from "fractional-indexing";

// Fractional-index sort keys (LexoRank-style) — the mobile twin of the web's
// utils/rank.js. The backend stores `rank` as opaque TEXT and orders
// lexicographically; a key can always be minted strictly between any two
// neighbours, so reordering a task touches exactly one row.

// Key strictly between `before` and `after` (either may be null for the
// start/end of the list). Used when a task is dropped between two rows.
export function rankBetween(before, after) {
	return generateKeyBetween(before ?? null, after ?? null);
}

// Key that places a new task at the very top (`topRank` = the current first
// task's rank, or null when the list is empty).
export function rankBefore(topRank) {
	return generateKeyBetween(null, topRank ?? null);
}
