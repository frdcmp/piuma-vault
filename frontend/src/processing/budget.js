// Token/size budget for extracted document text.
//
// Unlike a one-shot upload, anything extracted here is persisted on the chat
// message and re-sent to the model on EVERY later turn of that conversation.
// A 300-page PDF is therefore not a one-time cost, it's a permanent tax on the
// thread — so extraction is capped, and the cap is visible on the chip before
// the user hits send.

// ~4 chars/token is the usual English rule of thumb. Deliberately rough: this
// drives a "this is big" warning, not billing.
export const estimateTokens = (text) => Math.ceil((text?.length || 0) / 4);

// Per-file cap (~30k tokens) and per-turn cap across all attached files.
export const MAX_CHARS_PER_FILE = 120_000;
export const MAX_CHARS_PER_TURN = 240_000;

// Above this, the composer chip warns that the file will weigh on every turn.
export const HEAVY_TOKENS = 12_000;

// Cut `text` to `cap`, leaving a marker so the model knows it's seeing a
// prefix rather than the whole document (otherwise it confidently answers
// "the report doesn't mention X" about a page it never saw).
export const truncate = (text, cap = MAX_CHARS_PER_FILE) => {
	const full = text || "";
	if (full.length <= cap) return { text: full, truncated: false, omitted: 0 };
	const omitted = full.length - cap;
	return {
		text: `${full.slice(0, cap)}\n\n[… truncated: ${omitted.toLocaleString()} of ${full.length.toLocaleString()} characters omitted. Ask the user to attach a smaller excerpt if you need the rest. …]`,
		truncated: true,
		omitted,
	};
};

// Total extracted characters already staged for this turn.
export const turnChars = (pending) =>
	(pending || []).reduce((n, p) => n + (p.text?.length || 0), 0);
