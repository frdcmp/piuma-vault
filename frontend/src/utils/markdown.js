import remarkGfm from "remark-gfm";

// Shared react-markdown plugin list.
//
// GFM lets a *single* `~` open a strikethrough, so prose that uses `~` to mean
// "approximately" (`~5% ... (~$500)`) ends up struck through between the two
// tildes. `singleTilde: false` requires `~~` for a real strikethrough.
export const remarkPlugins = [[remarkGfm, { singleTilde: false }]];

// Turn the LaTeX that models sprinkle into prose into plain Unicode.
//
// Gemini in particular writes arrows as math — "PromptPay QR $\\to$ Send to
// IBKR" — and we don't render math, so the source shows through. Pulling in a
// math engine to draw an arrow isn't worth it: across a sample of real replies
// the only commands used were \\to and \\rightarrow (plus a stray \\times,
// \\approx, \\text), so they're mapped to the characters they stand for.
//
// Deliberately conservative, because `$` is also money: a span is only rewritten
// when it holds a backslash command AND no digits (so "costs $35 to $192" and
// even "pay $5 \\to $10", where the delimiters are ambiguous, are left alone),
// and anything with real math in it — exponents, subscripts, \\frac — is left
// for the reader to puzzle out rather than half-converted.
const MATH_SYMBOLS = {
	to: "→",
	rightarrow: "→",
	Rightarrow: "⇒",
	longrightarrow: "⟶",
	leftarrow: "←",
	Leftarrow: "⇐",
	leftrightarrow: "↔",
	mapsto: "↦",
	times: "×",
	div: "÷",
	cdot: "·",
	pm: "±",
	approx: "≈",
	neq: "≠",
	ne: "≠",
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	infty: "∞",
	ldots: "…",
	dots: "…",
	bullet: "•",
};

// Fenced blocks and code spans are left exactly as written — a snippet that
// contains LaTeX is showing it on purpose.
const CODE_SPANS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

const convertMath = (text) =>
	text.replace(/\$\$?([^$\n]{1,80})\$\$?/g, (whole, body) => {
		if (!/\\[a-zA-Z]/.test(body)) return whole;
		if (/[\d^_]|\\frac/.test(body)) return whole;
		const out = body
			.replace(/\\text\{([^{}]*)\}/g, "$1")
			.replace(/\\([a-zA-Z]+)/g, (cmd, name) =>
				Object.hasOwn(MATH_SYMBOLS, name) ? MATH_SYMBOLS[name] : cmd,
			)
			.replace(/[{}]/g, "")
			.trim();
		// An unmapped command means we don't understand the span — leave it whole.
		return /\\[a-zA-Z]/.test(out) ? whole : out;
	});

export function mathToUnicode(src) {
	if (typeof src !== "string" || !src.includes("$")) return src;
	return src
		.split(CODE_SPANS)
		.map((part, i) => (i % 2 ? part : convertMath(part)))
		.join("");
}
