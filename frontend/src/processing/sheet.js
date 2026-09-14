// Spreadsheets (xlsx/xls/xlsm/ods) and delimited text (csv/tsv) via SheetJS.
//
// Pinned to the maintained sheetjs.com build, NOT the npm `xlsx` package — the
// latter is frozen at 0.18.5 with open advisories. See package.json.

import { toMarkdownTable, trimGrid } from "./table";

let libPromise = null;
const lib = () => {
	libPromise ??= import("xlsx");
	// A failed load must not poison every later attach — clear the cache so the
	// next one retries instead of replaying the cached rejection.
	libPromise.catch(() => {
		libPromise = null;
	});
	return libPromise;
};

// A sheet past this many rows is data the user wants summarised, not read line
// by line; the per-file char cap would clip it mid-row anyway, so clip on a row
// boundary and say so.
const MAX_ROWS_PER_SHEET = 5_000;

export const extract = async (file) => {
	const XLSX = await lib();
	const workbook = XLSX.read(await file.arrayBuffer(), {
		type: "array",
		// Keep dates as dates rather than Excel serials — "45789" tells the model
		// nothing, "2025-05-14" tells it everything.
		cellDates: true,
	});
	const parts = [];
	const sheets = [];
	for (const name of workbook.SheetNames) {
		const ws = workbook.Sheets[name];
		if (!ws) continue;
		const grid = trimGrid(
			XLSX.utils.sheet_to_json(ws, {
				header: 1,
				blankrows: false,
				// Display text, so formula cells arrive as their computed values.
				raw: false,
				defval: "",
			}),
		);
		if (!grid.length) continue;
		const clipped = grid.length > MAX_ROWS_PER_SHEET;
		const body = clipped ? grid.slice(0, MAX_ROWS_PER_SHEET) : grid;
		sheets.push({ name, rows: grid.length, cols: body[0]?.length || 0 });
		const omitted = clipped
			? `\n\n[… ${grid.length - MAX_ROWS_PER_SHEET} further rows omitted from "${name}" …]`
			: "";
		parts.push(`## Sheet: ${name}\n\n${toMarkdownTable(body)}${omitted}`);
	}
	if (!parts.length) throw new Error(`${file.name} has no readable cells`);
	return { text: parts.join("\n\n"), meta: { sheets } };
};
