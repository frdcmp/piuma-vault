import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeChatMarkdown } from "../markdown";
import SpriteRunner from "../SpriteRunner";

// ── Content-block normalisation ───────────────────────────────────────────────
// The backend persists each message's `content` as an ordered list of typed
// blocks (text / image / tool_use / tool_result / thinking / injected). These
// helpers turn that wire shape into the pieces the UI renders.

export const newMessageId = () =>
	`msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
				if (out && typeof out === "object" && typeof out.title === "string")
					t.label = out.title;
			}
		} else if (b.type === "injected") {
			if (b.text)
				parts.push({ kind: "inject", id: `p${parts.length}`, text: b.text });
		}
	}
	return parts;
};

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
// URL). Returns null for anything unrecognised, so the action is dropped.
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

const NAV_FALLBACK_LABEL = {
	note: "note",
	event: "event",
	task: "task",
	view: "view",
	url: "link",
};

// Custom markdown <a>: internal app paths navigate client-side; external http(s)
// open in a new tab; anything else renders as inert text.
function VaultLink({ href = "", children, onNavigate }) {
	if (href.startsWith("/")) {
		return (
			<a
				className="vault-chat-link"
				href={href}
				onClick={(e) => {
					e.preventDefault();
					onNavigate?.(href);
				}}
			>
				{children}
			</a>
		);
	}
	if (/^https?:\/\//i.test(href)) {
		return (
			<a href={href} target="_blank" rel="noopener noreferrer">
				{children}
			</a>
		);
	}
	return <span>{children}</span>;
}

const TOOL_ICON = { running: "⚙", done: "✓", error: "✗" };

const toolArgsSummary = (args) => {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args)
		.filter(([, v]) => v !== null && v !== undefined && v !== "")
		.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
		.join(", ");
};

// Tool activity — which plugins the agent ran this turn (chips wrap to fit).
function ToolList({ tools }) {
	if (!tools?.length) return null;
	return (
		<div className="chat-tools">
			{tools.map((t) => {
				const summary = t.label || toolArgsSummary(t.args);
				return (
					<div key={t.id} className={`chat-tool chat-tool--${t.status}`}>
						<span className="chat-tool-icon" aria-hidden="true">
							{TOOL_ICON[t.status] || "⚙"}
						</span>
						<span className="chat-tool-name">{t.name}</span>
						{summary ? <span className="chat-tool-args">{summary}</span> : null}
					</div>
				);
			})}
		</div>
	);
}

export function UserBubble({ content, images }) {
	return (
		<div className="chat-user-row">
			<div className="chat-user-card">
				{images?.length ? (
					<div className="chat-user-images">
						{images.map((img) => (
							<a
								key={img.url}
								href={img.url}
								target="_blank"
								rel="noreferrer"
								className="chat-user-image"
							>
								<img src={img.url} alt="attachment" />
							</a>
						))}
					</div>
				) : null}
				{content ? <div className="chat-user-text">{content}</div> : null}
			</div>
		</div>
	);
}

export function AssistantBubble({ parts, isStreaming, label, onNavigate }) {
	const empty = !parts?.length;
	const mdComponents = useMemo(
		() => ({ a: (props) => <VaultLink {...props} onNavigate={onNavigate} /> }),
		[onNavigate],
	);
	return (
		<div className="chat-assistant-row">
			<span className="chat-role">{label}</span>
			<div className="chat-assistant-body">
				{empty && isStreaming ? (
					<div className="chat-thinking">
						<SpriteRunner pixelSize={2} />
						<div className="chat-thinking-body">
							<span className="chat-thinking-label">thinking…</span>
							<span className="chat-thinking-dots" aria-hidden="true">
								<i />
								<i />
								<i />
							</span>
						</div>
					</div>
				) : (
					<>
						{parts.map((p) => {
							if (p.kind === "tools")
								return <ToolList key={p.id} tools={p.tools} />;
							if (p.kind === "inject")
								return (
									<div key={p.id} className="chat-inject">
										<span className="chat-inject-label">you ↩</span>
										<span className="chat-inject-text">{p.text}</span>
									</div>
								);
							if (p.kind === "nav") {
								const to = navTargetToPath({
									target: p.target,
									id: p.navId,
									route: p.route,
									url: p.url,
								});
								if (!to) return null;
								const navLabel =
									p.label || NAV_FALLBACK_LABEL[p.target] || "open";
								return (
									<button
										key={p.id}
										type="button"
										className="chat-nav-action"
										onClick={() => onNavigate?.(to)}
										title={to}
									>
										<span className="chat-nav-action-icon" aria-hidden="true">
											↗
										</span>
										<span className="chat-nav-action-label">
											Go → {navLabel}
										</span>
									</button>
								);
							}
							return (
								<ReactMarkdown
									key={p.id}
									remarkPlugins={[remarkGfm]}
									components={mdComponents}
								>
									{normalizeChatMarkdown(p.text)}
								</ReactMarkdown>
							);
						})}
						{isStreaming ? <span className="chat-cursor" /> : null}
					</>
				)}
			</div>
		</div>
	);
}
