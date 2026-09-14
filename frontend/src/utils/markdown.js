import remarkGfm from "remark-gfm";

// Shared react-markdown plugin list.
//
// GFM lets a *single* `~` open a strikethrough, so prose that uses `~` to mean
// "approximately" (`~5% ... (~$500)`) ends up struck through between the two
// tildes. `singleTilde: false` requires `~~` for a real strikethrough.
export const remarkPlugins = [[remarkGfm, { singleTilde: false }]];

// Render the LaTeX that models sprinkle into prose as readable plain text.
//
// Gemini writes symbols and formulas as math — "PromptPay QR $\to$ Send to
// IBKR", "$$\text{Wh} = \frac{\text{mAh} \times \text{Volt}}{1000}$$" — and
// neither client renders math, so the source shows through. Rather than carry a
// math engine (one more dependency for a handful of arrows), the commands
// that actually turn up are rewritten into the characters they stand for:
//
//   \text{Wh} = \frac{\text{mAh} \times \text{Volt}}{1000}  →  Wh = (mAh × Volt) / 1000
//   E = mc^2                                                →  E = mc²
//
// Anything with a command we don't understand is left exactly as written — a
// half-converted formula is worse than a raw one.
//
// `$` is also money, so inline spans are gated: `$...$` is only treated as math
// when it holds a backslash command and doesn't open on a digit. That keeps
// "costs $35 to $192" and the genuinely ambiguous "pay $5 \to $10" intact.
// Display math (`$$...$$`) has no such ambiguity and is always converted.

const SYMBOLS = {
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
	mp: "∓",
	approx: "≈",
	equiv: "≡",
	propto: "∝",
	neq: "≠",
	ne: "≠",
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	ll: "≪",
	gg: "≫",
	infty: "∞",
	partial: "∂",
	sum: "∑",
	prod: "∏",
	int: "∫",
	degree: "°",
	circ: "°",
	percent: "%",
	ldots: "…",
	dots: "…",
	cdots: "⋯",
	bullet: "•",
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	Delta: "Δ",
	epsilon: "ε",
	theta: "θ",
	lambda: "λ",
	mu: "μ",
	pi: "π",
	rho: "ρ",
	sigma: "σ",
	Sigma: "Σ",
	tau: "τ",
	phi: "φ",
	omega: "ω",
	Omega: "Ω",
};

// Commands that only affect typesetting — drop the command, keep the content.
const PLAIN_GROUPS = [
	"text",
	"mathrm",
	"mathbf",
	"mathit",
	"operatorname",
	"mbox",
];
// Spacing commands and delimiters that carry no meaning in plain text.
const SPACING = [
	",",
	";",
	"!",
	" ",
	"quad",
	"qquad",
	"left",
	"right",
	"displaystyle",
];

const SUPERSCRIPT = {
	0: "⁰",
	1: "¹",
	2: "²",
	3: "³",
	4: "⁴",
	5: "⁵",
	6: "⁶",
	7: "⁷",
	8: "⁸",
	9: "⁹",
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	n: "ⁿ",
	i: "ⁱ",
};
const SUBSCRIPT = {
	0: "₀",
	1: "₁",
	2: "₂",
	3: "₃",
	4: "₄",
	5: "₅",
	6: "₆",
	7: "₇",
	8: "₈",
	9: "₉",
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
};

// Read a balanced {...} starting at `i` (which must point at the brace).
// Returns [contents, indexAfterGroup] or null when the braces don't balance.
const readGroup = (src, i) => {
	if (src[i] !== "{") return null;
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") {
			depth--;
			if (depth === 0) return [src.slice(i + 1, j), j + 1];
		}
	}
	return null;
};

// The argument of \frac, ^ or _: either a braced group or a single character.
const readArgument = (src, i) => {
	if (src[i] === "{") return readGroup(src, i);
	if (i < src.length) return [src[i], i + 1];
	return null;
};

// Wrap in parens only when the piece isn't already atomic, so we get
// "(mAh × Volt) / 1000" but "1/2" rather than "(1) / (2)".
const parenthesize = (piece) =>
	/^[\w.]+$/.test(piece) || /^\(.*\)$/.test(piece) ? piece : `(${piece})`;

const toScript = (piece, map) => {
	let out = "";
	for (const ch of piece) {
		if (!Object.hasOwn(map, ch)) return null;
		out += map[ch];
	}
	return out;
};

// Convert one LaTeX body to plain text, or null if anything is unrecognised.
const convertBody = (body) => {
	let out = "";
	let i = 0;
	while (i < body.length) {
		const ch = body[i];

		if (ch === "\\") {
			const match = /^\\([a-zA-Z]+|.)/.exec(body.slice(i));
			if (!match) return null;
			const name = match[1];
			i += match[0].length;

			if (name === "frac" || name === "dfrac" || name === "tfrac") {
				const numerator = readArgument(body, i);
				if (!numerator) return null;
				const denominator = readArgument(body, numerator[1]);
				if (!denominator) return null;
				const top = convertBody(numerator[0]);
				const bottom = convertBody(denominator[0]);
				if (top === null || bottom === null) return null;
				const spaced = /\s/.test(top.trim()) || /\s/.test(bottom.trim());
				out += `${parenthesize(top.trim())}${spaced ? " / " : "/"}${parenthesize(bottom.trim())}`;
				i = denominator[1];
				continue;
			}
			if (name === "sqrt") {
				const arg = readArgument(body, i);
				if (!arg) return null;
				const inner = convertBody(arg[0]);
				if (inner === null) return null;
				out += `√${parenthesize(inner.trim())}`;
				i = arg[1];
				continue;
			}
			if (PLAIN_GROUPS.includes(name)) {
				const arg = readArgument(body, i);
				if (!arg) return null;
				const inner = convertBody(arg[0]);
				if (inner === null) return null;
				out += inner;
				i = arg[1];
				continue;
			}
			if (SPACING.includes(name)) {
				// \left( and \right) precede a delimiter that stands on its own.
				if (name === "left" || name === "right") continue;
				out += name.length > 1 ? " " : "";
				continue;
			}
			if (Object.hasOwn(SYMBOLS, name)) {
				out += SYMBOLS[name];
				continue;
			}
			// An escaped literal: \$ \% \& \_ \{ \}
			if (name.length === 1 && "$%&_{}#".includes(name)) {
				out += name;
				continue;
			}
			return null;
		}

		if (ch === "^" || ch === "_") {
			const arg = readArgument(body, i + 1);
			if (!arg) return null;
			const inner = convertBody(arg[0]);
			if (inner === null) return null;
			const scripted = toScript(
				inner.trim(),
				ch === "^" ? SUPERSCRIPT : SUBSCRIPT,
			);
			if (scripted === null) return null;
			out += scripted;
			i = arg[1];
			continue;
		}

		if (ch === "{" || ch === "}") {
			i++;
			continue;
		}

		out += ch;
		i++;
	}
	return out.replace(/[ \t]{2,}/g, " ");
};

// Fenced blocks and code spans are left exactly as written — a snippet that
// contains LaTeX is showing it on purpose.
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

const convert = (text) =>
	text
		// Display math first: unambiguous, so no currency guard is needed.
		.replace(/\$\$([\s\S]{1,400}?)\$\$/g, (whole, body) => {
			const out = convertBody(body);
			return out === null ? whole : out.trim();
		})
		// Inline math: only when it holds a command and doesn't open on a digit,
		// so currency ("$35 to $192", "pay $5 \to $10") is never touched.
		.replace(/\$([^$\n]{1,120})\$/g, (whole, body) => {
			if (!/\\[a-zA-Z]/.test(body) && !/[_^]/.test(body)) return whole;
			if (/^\s*\d/.test(body)) return whole;
			const out = convertBody(body);
			return out === null ? whole : out.trim();
		});

export function mathToUnicode(src) {
	if (typeof src !== "string" || !src.includes("$")) return src;
	return src
		.split(CODE)
		.map((part, i) => (i % 2 ? part : convert(part)))
		.join("");
}
