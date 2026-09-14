// Word documents via mammoth: docx → HTML → structured markdown-ish text.
//
// Mammoth's HTML keeps the semantics we care about (headings, lists, tables)
// which a raw text dump throws away — a table flattened to a space-separated
// run of numbers is unreadable to a model.

import { toMarkdownTable } from "./table";

let libPromise = null;
const lib = () => {
	// Vite applies mammoth's `browser` field, swapping in its browser unzip.
	libPromise ??= import("mammoth").then((m) => m.default || m);
	libPromise.catch(() => {
		libPromise = null;
	});
	return libPromise;
};

const inlineText = (node) => node.textContent.replace(/\s+/g, " ").trim();

const HEADINGS = {
	h1: "#",
	h2: "##",
	h3: "###",
	h4: "####",
	h5: "#####",
	h6: "######",
};

const nodeToText = (node) => {
	if (node.nodeType === Node.TEXT_NODE) return node.textContent;
	if (node.nodeType !== Node.ELEMENT_NODE) return "";
	const tag = node.tagName.toLowerCase();

	const hash = HEADINGS[tag];
	if (hash) return `\n${hash} ${inlineText(node)}\n`;

	if (tag === "p") {
		const t = inlineText(node);
		return t ? `\n${t}\n` : "";
	}
	if (tag === "ul" || tag === "ol") {
		const ordered = tag === "ol";
		const items = Array.from(node.children).map(
			(li, i) => `${ordered ? `${i + 1}.` : "-"} ${inlineText(li)}`,
		);
		return items.length ? `\n${items.join("\n")}\n` : "";
	}
	if (tag === "table") {
		const rows = Array.from(node.querySelectorAll("tr")).map((tr) =>
			Array.from(tr.querySelectorAll("th, td")).map(inlineText),
		);
		const md = toMarkdownTable(rows);
		return md ? `\n${md}\n` : "";
	}
	if (tag === "br") return "\n";
	// Inline and block containers alike: recurse into the children.
	return Array.from(node.childNodes).map(nodeToText).join("");
};

export const extract = async (file) => {
	const mammoth = await lib();
	const { value: html, messages } = await mammoth.convertToHtml({
		arrayBuffer: await file.arrayBuffer(),
	});
	const doc = new DOMParser().parseFromString(html, "text/html");
	const text = nodeToText(doc.body)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!text) throw new Error(`${file.name} has no extractable text`);
	return {
		text,
		meta: { warnings: (messages || []).length },
	};
};
