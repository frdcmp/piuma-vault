// Content-block normalisation + small pure helpers shared by both chat surfaces
// (the embedded dock and the full-page chat).
//
// The backend persists each message's `content` as an ordered list of typed
// blocks (text / image / tool_use / tool_result / thinking / injected). These
// helpers turn that wire shape into the pieces the UI renders, and back again.

export const newMessageId = () =>
	`msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Last path segment of a note path (or the path itself) — the context-chip label.
export const noteLabel = (path) =>
	path.split("/").filter(Boolean).pop() || path;

// Normalised content blocks → plain text (history seed / user bubble text).
export const blocksToText = (content) => {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
	return "";
};

// Pull image blocks out of a persisted user message → [{ url, mediaType }].
export const blocksToImages = (content) => {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => b.type === "image" && b.url)
		.map((b) => ({ url: b.url, mediaType: b.media_type }));
};

// Walk persisted content blocks IN ORDER into renderable parts, so tools show up
// inline at the point they ran. A part is a `text` segment, a `tools` run, a
// `nav` action, or an `inject` marker. `tool_result` resolves the status of the
// matching `tool_use` in the current run; `thinking` blocks are skipped.
export const blocksToParts = (content) => {
	if (typeof content === "string")
		return content ? [{ kind: "text", id: "p0", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts = [];
	const tail = () => parts[parts.length - 1];
	for (const b of content) {
		if (b.type === "text") {
			if (!b.text) continue;
			const t = tail();
			if (t?.kind === "text") t.text += b.text;
			else parts.push({ kind: "text", id: `p${parts.length}`, text: b.text });
		} else if (b.type === "tool_use" && b.name === "navigate") {
			// A navigation intent renders as a "Go" action, not a tool chip.
			const a = b.input || {};
			parts.push({
				kind: "nav",
				id: `p${parts.length}`,
				target: a.target,
				navId: a.id,
				route: a.route,
				url: a.url,
				label: a.label,
			});
		} else if (b.type === "tool_use") {
			let run = tail();
			if (run?.kind !== "tools") {
				run = { kind: "tools", id: `p${parts.length}`, tools: [] };
				parts.push(run);
			}
			run.tools.push({
				id: `${run.id}-${run.tools.length}`,
				name: b.name,
				args: b.input,
				status: "done",
			});
		} else if (b.type === "tool_result") {
			const run = tail();
			const t =
				run?.kind === "tools" &&
				[...run.tools].reverse().find((x) => x.name === b.name);
			if (t) {
				const out = b.output;
				const isErr = out && typeof out === "object" && "error" in out;
				t.status = isErr ? "error" : "done";
				// Show the entity's name (note/task title) on the chip, not raw UUIDs.
				if (out && typeof out === "object" && typeof out.title === "string")
					t.label = out.title;
			}
		} else if (b.type === "injected") {
			// A mid-turn user injection, rendered inline where it landed.
			if (b.text)
				parts.push({ kind: "inject", id: `p${parts.length}`, text: b.text });
		}
	}
	return parts;
};

// Normalise a server message (get_conversation / switch-branch) into the client
// shape, carrying the model + tree/branch fields used by the per-message actions
// and the fork (‹n/n›) switcher.
export const mapServerMessage = (m) => ({
	id: m.id,
	role: m.role,
	content: blocksToText(m.content),
	parts: blocksToParts(m.content),
	images: blocksToImages(m.content),
	model: m.model_used || null,
	parentId: m.parent_id ?? null,
	branchIndex: m.branch_index ?? 1,
	branchCount: m.branch_count ?? 1,
	siblingIds: m.sibling_ids ?? [],
});

// Flatten the renderable parts back to plain text — the text segments joined in
// order (tool runs / nav actions are dropped). Used for copy-to-clipboard.
export const partsToText = (parts) =>
	(parts || [])
		.filter((p) => p.kind === "text")
		.map((p) => p.text)
		.join("\n\n")
		.trim();

// Append text to a parts array, extending the trailing text segment or adding a
// new one. Returns a new array (immutable update for setMessages).
export const appendTextPart = (parts, text) => {
	const next = [...(parts || [])];
	const t = next[next.length - 1];
	if (t?.kind === "text") next[next.length - 1] = { ...t, text: t.text + text };
	else next.push({ kind: "text", id: `p${next.length}`, text });
	return next;
};

// Map a `navigate`-tool intent to an in-app path (or pass through an external
// URL). Returns null for anything we don't recognise, so the action is dropped
// rather than sending the user somewhere bogus.
export const navTargetToPath = ({ target, id, route, url } = {}) => {
	switch (target) {
		case "note":
			return id ? `/notes/${id}` : null;
		case "event":
			return id ? `/calendar?event=${id}` : null;
		case "task":
			return id ? `/tasks?task=${id}` : null;
		case "view": {
			const r = (route || "").toLowerCase();
			if (r.includes("calendar")) return "/calendar";
			if (r.includes("task")) return "/tasks";
			if (r.includes("storage") || r.includes("file")) return "/storage";
			if (r.includes("note")) return "/notes";
			return null;
		}
		case "url":
			return /^https?:\/\//i.test(url || "") ? url : null;
		default:
			return null;
	}
};

export const NAV_FALLBACK_LABEL = {
	note: "note",
	event: "event",
	task: "task",
	view: "view",
	url: "link",
};
