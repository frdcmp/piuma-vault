// Frontend document-processing suite.
//
// One entry point — `extractFile(file)` — turns a user-chosen file into text
// the model can read, WITHOUT uploading it anywhere. A bank statement or a tax
// return is parsed in the browser and only its text reaches the server, so no
// publicly-fetchable copy of the original is ever created (unlike the image
// path, which has to hand the provider a CDN url it can fetch).
//
// Adding a format = one module here + one line in registry.js. Every parser is
// dynamically imported, so none of pdf.js / SheetJS / mammoth lands in the
// main bundle — they're fetched the first time someone attaches that format.

import { estimateTokens, MAX_CHARS_PER_FILE, truncate } from "./budget";
import { kindOf } from "./registry";

export {
	estimateTokens,
	HEAVY_TOKENS,
	MAX_CHARS_PER_TURN,
	turnChars,
} from "./budget";
export {
	ACCEPT_ATTR,
	kindOf,
	SUPPORTED_LABEL,
} from "./registry";

const EXTRACTORS = {
	pdf: () => import("./pdf"),
	sheet: () => import("./sheet"),
	docx: () => import("./docx"),
	text: () => import("./text"),
};

/**
 * Extract text from a non-image file.
 *
 * Resolves to:
 *   { kind, name, mime, size, text, chars, tokens, truncated, meta }
 * or, for a scanned PDF, `{ …, text: "", images: File[] }` — the caller sends
 * those through the existing image attachment path instead.
 *
 * Throws with a user-presentable message for unsupported or unreadable files.
 */
export const extractFile = async (file, { cap = MAX_CHARS_PER_FILE } = {}) => {
	const kind = kindOf(file);
	if (!kind || kind === "image")
		throw new Error(`Can't read ${file.name || "that file"}`);
	const load = EXTRACTORS[kind];
	if (!load) throw new Error(`Can't read ${file.name || "that file"}`);

	const { extract } = await load();
	const { text = "", images, meta = {} } = await extract(file);

	// Scanned PDF: nothing to inline, the caller gets page images instead.
	if (images?.length)
		return {
			kind,
			name: file.name,
			mime: file.type || "",
			size: file.size,
			text: "",
			chars: 0,
			tokens: 0,
			truncated: false,
			images,
			meta,
		};

	const clean = text.replace(/\r\n/g, "\n").trim();
	if (!clean) throw new Error(`${file.name} contained no readable text`);
	const { text: capped, truncated } = truncate(clean, cap);
	return {
		kind,
		name: file.name,
		mime: file.type || "",
		size: file.size,
		text: capped,
		chars: capped.length,
		tokens: estimateTokens(capped),
		truncated,
		meta,
	};
};
