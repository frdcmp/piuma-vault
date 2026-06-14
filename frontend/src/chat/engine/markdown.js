// Markdown normalisation for chat assistant text.
//
// LLMs frequently emit GFM tables in shapes that remark-gfm refuses to parse,
// so they render as a code block of raw `| … |` pipes or — worse — as a stray
// heading. The two failure modes we see in practice:
//   1. The whole table is indented ≥4 spaces (often after a list), so it is
//      swallowed by an indented-code block instead of being a table.
//   2. A row omits the outer pipes (`# | Task`); a leading `#` then turns the
//      header into an <h1> and the rest into a paragraph.
// `normalizeChatMarkdown` finds genuine table blocks (a header line followed by
// a `|---|` delimiter row) and repairs just those lines: dedent to column 0 and
// add the canonical outer pipes. Everything else is returned untouched.

// A `|---|:--:|` style delimiter row. Must contain a pipe (so a bare `---`
// horizontal rule is not mistaken for one) and at least one dash.
function isDelimiterRow(line) {
	const t = line.trim();
	if (!t.includes("|") || !t.includes("-")) return false;
	const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
	return cells.length >= 1 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

// Give a table row its canonical outer pipes if they are missing.
function withOuterPipes(line) {
	let t = line.trim();
	if (!t.startsWith("|")) t = `| ${t}`;
	if (!/\|$/.test(t)) t = `${t} |`;
	return t;
}

export function normalizeChatMarkdown(src) {
	if (typeof src !== "string" || !src.includes("|")) return src;

	const lines = src.split("\n");
	let changed = false;

	for (let i = 1; i < lines.length; i++) {
		if (!isDelimiterRow(lines[i])) continue;
		// The header is the line directly above the delimiter; bail if it is blank
		// (then this isn't actually a table — likely a thematic rule).
		const header = lines[i - 1];
		if (!header || !header.trim()) continue;

		// Block = header + delimiter + following non-blank lines (a GFM table ends
		// at the next blank line or end of input).
		let end = i + 1;
		while (end < lines.length && lines[end].trim()) end++;
		const start = i - 1;

		// Dedent the whole block by its smallest leading-whitespace run, so an
		// over-indented table escapes being treated as an indented code block.
		let minIndent = Number.POSITIVE_INFINITY;
		for (let j = start; j < end; j++) {
			const m = lines[j].match(/^[ \t]*/)[0].length;
			if (m < minIndent) minIndent = m;
		}
		for (let j = start; j < end; j++) {
			const dedented = minIndent > 0 ? lines[j].slice(minIndent) : lines[j];
			const repaired = withOuterPipes(dedented);
			if (repaired !== lines[j]) {
				lines[j] = repaired;
				changed = true;
			}
		}
		i = end; // skip past the block we just processed
	}

	return changed ? lines.join("\n") : src;
}
