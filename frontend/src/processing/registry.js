// Which extractor handles a given file.
//
// Dispatch is on extension FIRST, MIME second: browsers are unreliable about
// MIME for office formats (a .xlsx dropped from some file managers arrives as
// application/octet-stream, a .csv as text/plain), whereas the extension the
// user's own filesystem carries is almost always right.

const EXT = (name = "") => {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

// Extensions we extract text from, grouped by the module that handles them.
const BY_EXT = {
	pdf: "pdf",
	xlsx: "sheet",
	xls: "sheet",
	xlsm: "sheet",
	ods: "sheet",
	csv: "sheet",
	tsv: "sheet",
	docx: "docx",
	txt: "text",
	md: "text",
	markdown: "text",
	json: "text",
	log: "text",
	yml: "text",
	yaml: "text",
	xml: "text",
	html: "text",
	rtf: "text",
};

const BY_MIME = [
	[/^application\/pdf$/, "pdf"],
	[/spreadsheet|excel|^text\/csv$|^text\/tab-separated-values$/, "sheet"],
	[/wordprocessingml\.document$/, "docx"],
	[/^text\/|json|xml|yaml/, "text"],
];

// "image" | "pdf" | "sheet" | "docx" | "text" | null (unsupported).
export const kindOf = (file) => {
	if (!file) return null;
	const type = file.type || "";
	if (type.startsWith("image/")) return "image";
	const byExt = BY_EXT[EXT(file.name)];
	if (byExt) return byExt;
	for (const [re, kind] of BY_MIME) if (re.test(type)) return kind;
	return null;
};

// `accept` attribute for the composer's file input: images plus everything
// above. Kept in sync with BY_EXT by construction.
export const ACCEPT_ATTR = [
	"image/*",
	...Object.keys(BY_EXT).map((e) => `.${e}`),
].join(",");

// Human list for the "can't read this" toast.
export const SUPPORTED_LABEL = "PDF, Word, Excel/CSV, text, and images";
