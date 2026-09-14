// Rows of cells → a markdown table.
//
// Models read markdown tables far better than the tab-joined rows a naive
// sheet dump produces: the header row and the column alignment tell it which
// value belongs to which field, so it stops mixing up adjacent columns.

const cell = (v) => {
	if (v === null || v === undefined) return "";
	// Pipes would break the table; newlines would break the row.
	return String(v)
		.replace(/\|/g, "\\|")
		.replace(/\s*\n\s*/g, " ")
		.trim();
};

// Beyond this many columns a markdown table is wider than it is useful, and
// the separator row alone costs more tokens than the data — emit CSV instead.
export const MAX_TABLE_COLS = 24;

export const toMarkdownTable = (rows) => {
	const grid = (rows || []).map((r) => (Array.isArray(r) ? r.map(cell) : []));
	if (!grid.length) return "";
	const cols = Math.max(...grid.map((r) => r.length));
	if (!cols) return "";
	const padded = grid.map((r) => {
		const next = r.slice();
		while (next.length < cols) next.push("");
		return next;
	});
	if (cols > MAX_TABLE_COLS) return toCsv(padded);
	const [header, ...body] = padded;
	return [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map((r) => `| ${r.join(" | ")} |`),
	].join("\n");
};

// RFC4180-ish CSV, for grids too wide to table.
export const toCsv = (rows) =>
	(rows || [])
		.map((r) =>
			r
				.map((v) => {
					const s = cell(v);
					return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
				})
				.join(","),
		)
		.join("\n");

// Drop trailing all-empty rows/columns — spreadsheets are full of them and
// each one costs tokens for nothing.
export const trimGrid = (rows) => {
	let grid = (rows || []).map((r) => (Array.isArray(r) ? r.slice() : []));
	const isBlank = (v) =>
		v === null || v === undefined || String(v).trim() === "";
	while (grid.length && grid[grid.length - 1].every(isBlank)) grid.pop();
	const cols = Math.max(0, ...grid.map((r) => r.length));
	let lastCol = -1;
	for (let c = 0; c < cols; c++)
		if (grid.some((r) => !isBlank(r[c]))) lastCol = c;
	if (lastCol < 0) return [];
	grid = grid.map((r) => r.slice(0, lastCol + 1));
	return grid;
};
