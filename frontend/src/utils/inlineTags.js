// Inline tags typed in a note body or a chat message.
//
// One syntax only: `#k8s`, optionally nested like `#infra/k8s`. A tag name
// starts with a letter or digit and may contain letters, digits, `_`, `-` and
// `/` segment separators. Square brackets are NOT tags.
//
// The exact same logic lives in mobile/src/utils/inlineTags.js so web and
// mobile agree on what counts as a tag. No lookbehind is used (Hermes).

const TAG_NAME = "[A-Za-z0-9][A-Za-z0-9_-]*(?:/[A-Za-z0-9][A-Za-z0-9_-]*)*";

// The leading character is captured (group 1) rather than a regex lookbehind:
// `#` is a tag only when not glued to a preceding word/`#`/`&`/`/`, so `C#`,
// `##`, URLs and `&#39;` don't become tags.
const TAG_RE = new RegExp(`(^|[^\\w#&/])#(${TAG_NAME})`, "gu");

// Split a run of plain text into text and tag parts. Code spans/fences must be
// handled by the caller (they are parsed nodes by the time this runs on web,
// and are skipped by the mobile token walker).
export function splitInlineTags(text) {
	if (typeof text !== "string" || text.length === 0) {
		return [{ type: "text", value: text ?? "" }];
	}
	const out = [];
	let last = 0;
	TAG_RE.lastIndex = 0;
	let m = TAG_RE.exec(text);
	while (m !== null) {
		const prefix = m[1] ?? "";
		const name = m[2];
		const tagStart = m.index + prefix.length;
		if (m.index > last) {
			out.push({ type: "text", value: text.slice(last, m.index) });
		}
		if (prefix) out.push({ type: "text", value: prefix });
		out.push({
			type: "tag",
			name,
			raw: text.slice(tagStart, m.index + m[0].length),
		});
		last = m.index + m[0].length;
		m = TAG_RE.exec(text);
	}
	if (last < text.length) out.push({ type: "text", value: text.slice(last) });
	return out;
}

// mdast node types whose text must never be turned into tags.
const SKIP_TYPES = new Set([
	"code",
	"inlineCode",
	"html",
	"yaml",
	"toml",
	"math",
	"inlineMath",
]);

function tagNode(name) {
	return {
		type: "inlineTag",
		name,
		// Let remark-rehype emit a plain <span class="inline-tag" data-tag=…>;
		// the React layer turns it into the pill.
		data: {
			hName: "span",
			hProperties: { className: ["inline-tag"], "data-tag": name },
		},
		children: [{ type: "text", value: `#${name}` }],
	};
}

function walk(node) {
	if (!node || !Array.isArray(node.children)) return;
	if (SKIP_TYPES.has(node.type)) return;
	const next = [];
	for (const child of node.children) {
		if (child.type === "text" && typeof child.value === "string") {
			const parts = splitInlineTags(child.value);
			if (parts.length === 1 && parts[0].type === "text") {
				next.push(child);
				continue;
			}
			for (const part of parts) {
				next.push(
					part.type === "tag"
						? tagNode(part.name)
						: { type: "text", value: part.value },
				);
			}
		} else {
			walk(child);
			next.push(child);
		}
	}
	node.children = next;
}

// remark plugin: replace `#tag` runs with inline-tag spans.
export function remarkInlineTags() {
	return (tree) => walk(tree);
}
