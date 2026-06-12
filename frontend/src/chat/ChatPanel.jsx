import { DeleteOutlined, FormOutlined } from "@ant-design/icons";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { PvModal, pvMessage } from "@/admin/components/ui";
import {
	clearConversation,
	createConversation,
	deleteConversation,
	fetchAllModels,
	fetchConversation,
	fetchConversations,
	injectMessage,
	retitleConversation,
	stopConversation,
	streamChat,
	updateConversation,
} from "../api/agentChatApi";
import { uploadChatImage } from "../api/storage";
import { useAgentList, useDefaultAgent } from "../queries";

// Universal client commands (same for every agent). Agent-specific commands are
// the prompt macros from db_agent_profiles.commands, merged in at render time.
const CLIENT_COMMANDS = [
	{ name: "new", description: "Start a new conversation" },
	{ name: "clear", description: "Wipe this conversation's messages" },
	{ name: "sessions", description: "Switch to another conversation" },
	{ name: "models", description: "Pick the model for this chat" },
	{ name: "title", description: "Rename this conversation" },
];

// The two options shown after `/title`.
const TITLE_ACTIONS = [
	{
		key: "auto",
		label: "Auto-rename with AI",
		desc: "Generate a title from the conversation",
	},
	{ key: "manual", label: "Edit manually", desc: "Type a new title yourself" },
];

import useNotesWorkspaceStore from "../store/notesWorkspaceStore";
import SpriteRunner from "./SpriteRunner";
import "./ChatPage.css";

// Persists the active conversation so the panel restores it across mounts.
const STORAGE_KEY = "pv:agents-active-conv";

const noteLabel = (path) => path.split("/").filter(Boolean).pop() || path;

const newMessageId = () =>
	`msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Normalised content blocks → plain text (for rendering + history seed).
const blocksToText = (content) => {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
	return "";
};

// Pull the image blocks out of a persisted user message → [{ url, mediaType }].
const blocksToImages = (content) => {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => b.type === "image" && b.url)
		.map((b) => ({ url: b.url, mediaType: b.media_type }));
};

// Walk persisted content blocks IN ORDER into renderable parts, so tools show up
// inline at the point they ran rather than all grouped together. A part is either
// a `text` segment or a `tools` run (consecutive tool chips between text). A
// `tool_result` sets the status of the matching `tool_use` in the current run;
// `thinking` blocks are skipped (not rendered, don't split a tool run).
const blocksToParts = (content) => {
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
				// Show the entity's name (e.g. note/task title) on the chip instead
				// of the raw UUID args.
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

// Append text to a parts array, extending the trailing text segment or adding a
// new one. Returns a new array (immutable update for setMessages).
const appendTextPart = (parts, text) => {
	const next = [...(parts || [])];
	const t = next[next.length - 1];
	if (t?.kind === "text") next[next.length - 1] = { ...t, text: t.text + text };
	else next.push({ kind: "text", id: `p${next.length}`, text });
	return next;
};

// Map a `navigate`-tool intent to an in-app path (or pass through an external
// URL). Returns null for anything we don't recognise, so the action is dropped
// rather than sending the user somewhere bogus.
const navTargetToPath = ({ target, id, route, url } = {}) => {
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

// Custom markdown <a>: internal app paths navigate client-side (keeping the
// chat dock open); external http(s) links open in a new tab; anything else
// (e.g. a stripped/odd scheme) renders as inert text.
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

// Compact one-line summary of a tool's arguments for the chip.
const toolArgsSummary = (args) => {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args)
		.filter(([, v]) => v !== null && v !== undefined && v !== "")
		.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
		.join(", ");
};

// Tool activity — always shown in full (chips wrap to fit). No
// collapse-to-summary on completion; the run stays visible as a record.
function ToolList({ tools }) {
	if (!tools?.length) return null;
	return (
		<div className="chat-tools">
			{tools.map((t) => {
				// Prefer a resolved entity name (note/task title) over raw UUID args.
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

// One context chip — transient (from an open tab, dimmed; click to lock) or
// locked (pinned, solid; × to unlock). Read-only inside a sent bubble.
function ContextTag({ label, title, locked, preview, onClick, onRemove }) {
	const inner = (
		<>
			<span className="chat-context-tag-icon" aria-hidden="true">
				{locked ? "◆" : "◇"}
			</span>
			<span className="chat-context-tag-label">{label}</span>
		</>
	);
	return (
		<span
			className={`chat-context-tag ${locked ? "locked" : "transient"} ${
				!locked && preview ? "preview" : ""
			}`}
			title={title}
		>
			{onClick ? (
				<button
					type="button"
					className="chat-context-tag-main"
					onClick={onClick}
					title={
						locked
							? "Click to open this note"
							: "Click to keep this note in context"
					}
				>
					{inner}
				</button>
			) : (
				<span className="chat-context-tag-main">{inner}</span>
			)}
			{onRemove ? (
				<button
					type="button"
					className="chat-context-tag-x"
					onClick={onRemove}
					aria-label={`Remove ${label} from context`}
				>
					×
				</button>
			) : null}
		</span>
	);
}

function UserBubble({ content, context, images }) {
	return (
		<div className="chat-user-row">
			<div className="chat-user-card">
				{context?.length ? (
					<div className="chat-context-tags chat-context-tags--bubble">
						{context.map((path) => (
							<ContextTag
								key={path}
								label={noteLabel(path)}
								title={path}
								locked
							/>
						))}
					</div>
				) : null}
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

function AssistantBubble({ parts, isStreaming, label, onNavigate }) {
	const empty = !parts?.length;
	// Bind the custom link renderer to this bubble's navigation handler.
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
						{/* Text, tool runs, and mid-turn injections — in stream order. */}
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
									{p.text}
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

// Embedded chat panel — runs on the agents API. Pick the agent (default set in
// admin → Agents), stream the reply, and attach "locked" notes as context.
export default function ChatPanel({ onClose, onOpenNote }) {
	const navigate = useNavigate();
	// Single navigation entry point for chat links and "Go" actions: internal
	// app paths route client-side (dock stays open); external http(s) open a new
	// tab. Note links prefer onOpenNote (workspace bridge) when provided.
	const goTo = useCallback(
		(to) => {
			if (!to) return;
			if (/^https?:\/\//i.test(to)) {
				window.open(to, "_blank", "noopener,noreferrer");
				return;
			}
			if (!to.startsWith("/")) return;
			// Salvage note links the agent built from the note's folder path + id
			// (e.g. /projects/piuma-vault/<uuid>) instead of the canonical
			// /notes/<id>. Any internal path carrying a note UUID that isn't a known
			// route IS a note. (Calendar/task carry their UUID in a query param, and
			// start with /admin or /tasks, so they're excluded.)
			let path = to;
			const uuid = path.match(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
			);
			if (uuid && !/^\/(notes|tasks|storage|admin)\b/.test(path)) {
				path = `/notes/${uuid[0]}`;
			}
			const noteMatch = path.match(/^\/notes\/([^/?#]+)$/);
			if (noteMatch && onOpenNote) onOpenNote(noteMatch[1]);
			else navigate(path);
		},
		[navigate, onOpenNote],
	);
	const { data: agents = [] } = useAgentList();
	const { data: def } = useDefaultAgent();
	const [agentKind, setAgentKind] = useState("");
	useEffect(() => {
		if (def?.agent && !agentKind) setAgentKind(def.agent);
	}, [def, agentKind]);
	const effectiveAgent = agentKind || def?.agent || "vault_agent";
	const agentLabel =
		agents.find((a) => a.kind === effectiveAgent)?.display_name || "Piuma";

	const [messages, setMessages] = useState([]);
	const [input, setInput] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const [compact, setCompact] = useState(false);
	const [confirmClearOpen, setConfirmClearOpen] = useState(false);
	const [overlay, setOverlay] = useState(null); // null | "models" | "sessions"
	const [pickList, setPickList] = useState([]);
	const [slashActive, setSlashActive] = useState(0); // highlighted slash item
	const [overlayActive, setOverlayActive] = useState(0); // highlighted picker row
	const [sessionQuery, setSessionQuery] = useState(""); // sessions search box
	const [titleMenu, setTitleMenu] = useState(false); // /title two-option menu
	const [titleActive, setTitleActive] = useState(0); // highlighted title option
	const [conversationId, setConversationId] = useState(
		() => localStorage.getItem(STORAGE_KEY) || null,
	);
	// The model bound to the active conversation (db_chat_conversations.model_id),
	// or null when it hasn't been overridden — then the backend uses the default,
	// so the model flagged is_default is the one actually in use.
	const [modelId, setModelId] = useState(null);
	// All enabled models (fetched once), so the composer can read the ACTIVE
	// model's capabilities — chiefly `supports_vision` to gate image attach.
	const [allModels, setAllModels] = useState([]);
	// Images pasted/attached for the next turn, each:
	// { id, localUrl, url, key, mediaType, name, w, h, status: "uploading"|"ready"|"error" }.
	const [pendingImages, setPendingImages] = useState([]);
	// Only restore when a stored conversation exists; a fresh panel (and any
	// conversation created later this session) starts already-hydrated so the
	// restore effect never clobbers live streaming state.
	const [hydrated, setHydrated] = useState(
		() => !localStorage.getItem(STORAGE_KEY),
	);
	// True while a conversation's history is being fetched (restore on mount or a
	// /sessions switch) — drives the pixel-Piuma loader so the panel doesn't read
	// as "empty" mid-load and then pop. Seeded true when there's a stored
	// conversation to restore.
	const [loadingConv, setLoadingConv] = useState(
		() => !!localStorage.getItem(STORAGE_KEY),
	);
	// The currently-shown conversation, as a ref — so async writers (a detached
	// stream, the recover poller) can bail if the user has switched away, instead
	// of clobbering the conversation now on screen.
	const conversationIdRef = useRef(conversationId);
	useEffect(() => {
		conversationIdRef.current = conversationId;
	}, [conversationId]);
	const scrollRef = useRef(null);
	const abortRef = useRef(null);
	const inputRef = useRef(null);
	// Return focus to the composer after any picker/menu operation, so the whole
	// flow stays keyboard-driven (no click needed to type again). rAF waits for
	// the picker's unmount to commit before we grab focus back.
	const focusInput = useCallback(() => {
		requestAnimationFrame(() => inputRef.current?.focus());
	}, []);
	// Stick-to-bottom: only auto-follow new content while parked near the bottom.
	// Scrolling up releases the lock (so streaming stops yanking you down) and
	// reveals a jump-to-latest button.
	const atBottomRef = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 80;
		atBottomRef.current = atBottom;
		setShowJump((p) => (p === !atBottom ? p : !atBottom));
	}, []);

	const scrollToBottom = useCallback(() => {
		atBottomRef.current = true;
		setShowJump(false);
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);
	const slashActiveRef = useRef(null);
	const overlayActiveRef = useRef(null);

	// Restore the stored conversation once on mount.
	useEffect(() => {
		if (hydrated || !conversationId) return;
		let cancelled = false;
		fetchConversation(conversationId)
			.then((d) => {
				if (cancelled) return;
				setModelId(d.conversation?.model_id || null);
				setMessages(
					(d.messages || []).map((m) => ({
						id: m.id,
						role: m.role,
						content: blocksToText(m.content),
						parts: blocksToParts(m.content),
						images: blocksToImages(m.content),
					})),
				);
				setHydrated(true);
				setLoadingConv(false);
			})
			.catch(() => {
				localStorage.removeItem(STORAGE_KEY);
				setConversationId(null);
				setHydrated(true);
				setLoadingConv(false);
			});
		return () => {
			cancelled = true;
		};
	}, [conversationId, hydrated]);

	// Swap to a shorter placeholder when the panel is narrow.
	useEffect(() => {
		const el = inputRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(([entry]) => {
			setCompact(entry.contentRect.width < 240);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when input text changes
	useLayoutEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		const sh = el.scrollHeight;
		el.style.height = `${sh}px`;
		// If content overflows after setting, add border width
		if (el.scrollHeight > el.clientHeight) {
			const cs = getComputedStyle(el);
			const bh =
				parseInt(cs.borderTopWidth, 10) + parseInt(cs.borderBottomWidth, 10);
			el.style.height = `${sh + bh}px`;
		}
	}, [input]);

	const openTabs = useNotesWorkspaceStore((s) => s.tabs);
	const lockedContext = useNotesWorkspaceStore((s) => s.lockedContext);
	const lockContext = useNotesWorkspaceStore((s) => s.lockContext);
	const unlockContext = useNotesWorkspaceStore((s) => s.unlockContext);

	const contextChips = useMemo(() => {
		const lockedIds = new Set(lockedContext.map((t) => t.id));
		const unlocked = openTabs.filter((t) => !lockedIds.has(t.id));
		return [
			...lockedContext.map((t) => ({ ...t, locked: true })),
			...unlocked.map((t) => ({ ...t, locked: false })),
		];
	}, [openTabs, lockedContext]);

	const sentContextPaths = useMemo(
		() => lockedContext.map((t) => t.path).filter(Boolean),
		[lockedContext],
	);
	const sentContextIds = useMemo(
		() => lockedContext.map((t) => t.id).filter(Boolean),
		[lockedContext],
	);

	// Load the model catalog once so the composer knows the active model's
	// capabilities (vision). Refreshed lazily by the /models picker too.
	useEffect(() => {
		fetchAllModels()
			.then(setAllModels)
			.catch(() => {});
	}, []);

	// The model actually in use: the conversation's override, or the default.
	const activeModel = useMemo(() => {
		if (!allModels.length) return null;
		return modelId
			? allModels.find((m) => m.id === modelId)
			: allModels.find((m) => m.is_default);
	}, [allModels, modelId]);
	const visionEnabled = !!activeModel?.supports_vision;

	const fileInputRef = useRef(null);
	const uploadingImages = pendingImages.some((p) => p.status === "uploading");

	const removePendingImage = useCallback((id) => {
		setPendingImages((curr) => {
			const hit = curr.find((p) => p.id === id);
			if (hit?.localUrl) URL.revokeObjectURL(hit.localUrl);
			return curr.filter((p) => p.id !== id);
		});
	}, []);

	// Upload an image file to the disposable __temp/chat/ prefix, showing an
	// optimistic local thumbnail immediately and swapping in the CDN URL when the
	// upload lands. Gated on the active model supporting vision.
	const addImageFile = useCallback(
		(file) => {
			if (!file?.type?.startsWith("image/")) return;
			if (!visionEnabled) {
				pvMessage.info(
					"This model can't read images — switch to a vision model first.",
				);
				return;
			}
			const id = newMessageId();
			const localUrl = URL.createObjectURL(file);
			const probe = new Image();
			probe.onload = () =>
				setPendingImages((curr) =>
					curr.map((p) =>
						p.id === id
							? { ...p, w: probe.naturalWidth, h: probe.naturalHeight }
							: p,
					),
				);
			probe.src = localUrl;
			setPendingImages((curr) => [
				...curr,
				{
					id,
					localUrl,
					url: null,
					key: null,
					mediaType: file.type || "image/png",
					name: file.name || "image.png",
					w: 0,
					h: 0,
					status: "uploading",
				},
			]);
			uploadChatImage({ file, conversationId: conversationIdRef.current })
				.then(({ key, publicUrl, media_type }) =>
					setPendingImages((curr) =>
						curr.map((p) =>
							p.id === id
								? {
										...p,
										url: publicUrl,
										key,
										mediaType: media_type || p.mediaType,
										status: "ready",
									}
								: p,
						),
					),
				)
				.catch(() => {
					pvMessage.error("Image upload failed");
					removePendingImage(id);
				});
		},
		[visionEnabled, removePendingImage],
	);

	// Paste handler: grab any image items off the clipboard.
	const onPaste = useCallback(
		(e) => {
			const items = e.clipboardData?.items || [];
			let handled = false;
			for (const it of items) {
				if (it.kind === "file" && it.type.startsWith("image/")) {
					const f = it.getAsFile();
					if (f) {
						addImageFile(f);
						handled = true;
					}
				}
			}
			if (handled) e.preventDefault();
		},
		[addImageFile],
	);

	const onDrop = useCallback(
		(e) => {
			const files = e.dataTransfer?.files;
			if (!files?.length) return;
			let handled = false;
			for (const f of files) {
				if (f.type.startsWith("image/")) {
					addImageFile(f);
					handled = true;
				}
			}
			if (handled) e.preventDefault();
		},
		[addImageFile],
	);

	useEffect(() => () => abortRef.current?.abort(), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
	useEffect(() => {
		// Follow new content only when parked at the bottom; respect scroll-up.
		if (!atBottomRef.current || !scrollRef.current) return;
		scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [messages]);

	const confirmClear = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setLoadingConv(false);
		setMessages([]);
		setConversationId(null);
		setModelId(null);
		localStorage.removeItem(STORAGE_KEY);
		setConfirmClearOpen(false);
	}, []);

	// STOP: kill the running turn immediately — abort the local stream (instant
	// UI) and tell the backend to cancel so it stops generating mid-stream.
	const stopStreaming = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		if (conversationId) stopConversation(conversationId).catch(() => {});
	}, [conversationId]);

	// Recover from a dropped stream: the turn keeps running + is persisted
	// server-side, so poll the conversation until the assistant message lands,
	// then rebuild from server truth (what a manual reload does, automatically).
	const recoverTurn = useCallback(async (convId) => {
		for (let i = 0; i < 24; i++) {
			await new Promise((r) => setTimeout(r, 2500)); // ~60s total
			// Bail if the user switched away — don't overwrite another conversation.
			if (conversationIdRef.current !== convId) return;
			try {
				const d = await fetchConversation(convId);
				if (conversationIdRef.current !== convId) return;
				const msgs = d.messages || [];
				const last = msgs[msgs.length - 1];
				if (last && last.role === "assistant") {
					setMessages(
						msgs.map((m) => ({
							id: m.id,
							role: m.role,
							content: blocksToText(m.content),
							parts: blocksToParts(m.content),
							images: blocksToImages(m.content),
						})),
					);
					return;
				}
			} catch {
				/* keep trying */
			}
		}
		if (conversationIdRef.current !== convId) return;
		setMessages((curr) => {
			const updated = [...curr];
			const last = updated[updated.length - 1];
			if (last?.role === "assistant") {
				updated[updated.length - 1] = {
					...last,
					content:
						"_The reply is taking a while. Reopen this chat to see it once it finishes._",
				};
			}
			return updated;
		});
	}, []);

	const sendMessage = useCallback(async () => {
		const text = input.trim();
		const readyImages = pendingImages.filter(
			(p) => p.status === "ready" && p.url,
		);
		if (!text && !readyImages.length) return;

		// While a turn is streaming, a send INJECTS into it instead of starting a
		// new turn; the running turn picks it up at the next round boundary.
		if (isStreaming) {
			if (!conversationId) return;
			// Drop the injection inline into the streaming assistant turn, at the
			// point it was typed — not hoisted above the whole reply. The backend
			// records it as an `injected` block at the same spot, so reloads match.
			setMessages((curr) => {
				const next = [...curr];
				const last = next[next.length - 1];
				if (last?.role === "assistant") {
					const parts = [...(last.parts || [])];
					parts.push({ kind: "inject", id: `p${parts.length}`, text });
					next[next.length - 1] = { ...last, parts };
				}
				return next;
			});
			setInput("");
			scrollToBottom();
			try {
				await injectMessage(conversationId, text);
			} catch {
				/* 409 = the turn just ended; best-effort */
			}
			return;
		}

		let convId = conversationId;
		if (!convId) {
			try {
				const conv = await createConversation({ agent: effectiveAgent });
				convId = conv.id;
				setConversationId(conv.id);
				setModelId(conv.model_id || null);
				localStorage.setItem(STORAGE_KEY, conv.id);
			} catch {
				setMessages((c) => [
					...c,
					{
						id: newMessageId(),
						role: "assistant",
						content: "**Error:** failed to start conversation",
					},
				]);
				return;
			}
		}

		const userMsg = {
			id: newMessageId(),
			role: "user",
			content: text,
			...(sentContextPaths.length ? { context: sentContextPaths } : {}),
			...(readyImages.length
				? {
						images: readyImages.map((p) => ({
							url: p.url,
							mediaType: p.mediaType,
						})),
					}
				: {}),
		};
		const assistantMsg = {
			id: newMessageId(),
			role: "assistant",
			parts: [],
		};
		setMessages((curr) => [...curr, userMsg, assistantMsg]);
		setInput("");
		// Sent → drop the pending chips (the CDN urls now live on the message).
		setPendingImages((curr) => {
			for (const p of curr) if (p.localUrl) URL.revokeObjectURL(p.localUrl);
			return [];
		});
		setIsStreaming(true);
		scrollToBottom(); // sending re-arms the stick-to-bottom lock

		const controller = new AbortController();
		abortRef.current = controller;

		// Append text to the streaming assistant message's ordered parts.
		const appendText = (delta) =>
			setMessages((curr) => {
				const updated = [...curr];
				const last = updated[updated.length - 1];
				updated[updated.length - 1] = {
					...last,
					parts: appendTextPart(last.parts, delta),
				};
				return updated;
			});

		try {
			await streamChat({
				conversationId: convId,
				message: text,
				contextNoteIds: sentContextIds,
				images: readyImages.map((p) => ({
					url: p.url,
					key: p.key,
					media_type: p.mediaType,
				})),
				signal: controller.signal,
				onText: appendText,
				onThinking: () => {},
				// Tools land in stream order: a new call opens (or extends) the
				// trailing tool-run part; its completion flips that chip's status.
				// The `navigate` tool is special — it renders a "Go" action, not a
				// chip — so it's handled up front (only on announce; ignore `done`).
				onTool: (t) => {
					if (t.name === "navigate") {
						if (t.done) return;
						setMessages((curr) => {
							const updated = [...curr];
							const last = { ...updated[updated.length - 1] };
							const parts = [...(last.parts || [])];
							const a = t.args || {};
							parts.push({
								kind: "nav",
								id: `p${parts.length}`,
								target: a.target,
								navId: a.id,
								route: a.route,
								url: a.url,
								label: a.label,
							});
							last.parts = parts;
							updated[updated.length - 1] = last;
							return updated;
						});
						return;
					}
					setMessages((curr) => {
						const updated = [...curr];
						const last = { ...updated[updated.length - 1] };
						const parts = [...(last.parts || [])];
						if (t.done) {
							for (let i = parts.length - 1; i >= 0; i--) {
								if (parts[i].kind !== "tools") continue;
								const idx = parts[i].tools.findIndex((x) => x.id === t.id);
								if (idx >= 0) {
									const tools = [...parts[i].tools];
									tools[idx] = {
										...tools[idx],
										label: t.label || tools[idx].label,
										status: t.ok ? "done" : "error",
									};
									parts[i] = { ...parts[i], tools };
									break;
								}
							}
						} else {
							let run = parts[parts.length - 1];
							if (run?.kind !== "tools") {
								run = { kind: "tools", id: `p${parts.length}`, tools: [] };
								parts.push(run);
							} else {
								run = { ...run, tools: [...run.tools] };
								parts[parts.length - 1] = run;
							}
							run.tools.push({
								id: t.id,
								name: t.name,
								args: t.args,
								status: "running",
							});
						}
						last.parts = parts;
						updated[updated.length - 1] = last;
						return updated;
					});
				},
				onError: (e) => {
					// A transport drop (stream reset / connection abort) doesn't mean
					// the turn failed — it keeps running and is persisted server-side.
					// Show a soft "reconnecting" note and refetch until it lands,
					// instead of a hard error.
					if (e?.isTransport && convId) {
						appendText("\n\n_(reconnecting…)_");
						recoverTurn(convId);
						return;
					}
					appendText(`\n\n**Error:** ${e.message}`);
				},
				onDone: () => setIsStreaming(false),
			});
		} finally {
			// Always re-enable the composer, even if the stream throws.
			setIsStreaming(false);
			abortRef.current = null;
		}
	}, [
		input,
		isStreaming,
		conversationId,
		effectiveAgent,
		sentContextPaths,
		sentContextIds,
		pendingImages,
		recoverTurn,
		scrollToBottom,
	]);

	// Slash commands: client commands + the active agent's macros, filtered by
	// the typed token (active only while the input is a single `/word`).
	const agentCommands = useMemo(
		() => agents.find((a) => a.kind === effectiveAgent)?.commands || [],
		[agents, effectiveAgent],
	);
	const slashMatches = useMemo(() => {
		if (!input.startsWith("/") || /\s/.test(input)) return [];
		const q = input.slice(1).toLowerCase();
		const client = CLIENT_COMMANDS.map((c) => ({ ...c, kind: "client" }));
		const agent = (Array.isArray(agentCommands) ? agentCommands : []).map(
			(c) => ({
				...c,
				kind: "agent",
			}),
		);
		return [...client, ...agent].filter((c) =>
			(c.name || "").toLowerCase().startsWith(q),
		);
	}, [input, agentCommands]);

	// Keep the keyboard-highlighted slash item scrolled into view.
	useEffect(() => {
		if (slashActive >= 0) {
			slashActiveRef.current?.scrollIntoView({ block: "nearest" });
		}
	}, [slashActive]);

	// Keep the keyboard-highlighted picker (sessions/models) row in view.
	useEffect(() => {
		if (overlayActive >= 0) {
			overlayActiveRef.current?.scrollIntoView({ block: "nearest" });
		}
	}, [overlayActive]);

	// While the sessions list is loading, show the pixel-Piuma loader (kept up for
	// a ~1s floor so the open doesn't flash "None" → list). Only the initial open
	// arms the floor; search refetches update the list in place.
	const [sessionsLoading, setSessionsLoading] = useState(false);
	const sessionsMinUntil = useRef(0);

	// Load the sessions list (debounced) whenever the picker is open and the
	// search query changes. `q` matches conversation title or message text.
	useEffect(() => {
		if (overlay !== "sessions") return;
		const q = sessionQuery.trim();
		let cancelled = false;
		const t = setTimeout(async () => {
			try {
				const data = await fetchConversations(undefined, q || undefined);
				if (cancelled) return;
				const finish = () => {
					if (cancelled) return;
					setPickList(data);
					setOverlayActive(0);
					setSessionsLoading(false);
				};
				const wait = Math.max(0, sessionsMinUntil.current - Date.now());
				if (wait > 0) setTimeout(finish, wait);
				else finish();
			} catch {
				if (!cancelled) setSessionsLoading(false);
			}
		}, 200);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, [overlay, sessionQuery]);

	const startNewChat = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setLoadingConv(false);
		setMessages([]);
		setConversationId(null);
		setModelId(null);
		localStorage.removeItem(STORAGE_KEY);
		setInput("");
		setTitleMenu(false);
	}, []);

	// Wipe the current conversation's messages but keep the same conversation
	// (and its id), so the thread continues in place. With no active
	// conversation this is just a local reset.
	const clearMessages = useCallback(async () => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setMessages([]);
		setInput("");
		setTitleMenu(false);
		if (!conversationId) return;
		try {
			await clearConversation(conversationId);
		} catch {
			/* ignore */
		}
	}, [conversationId]);

	const switchConversation = useCallback(async (id) => {
		setOverlay(null);
		setTitleMenu(false);
		// Detach any active stream WITHOUT cancelling the backend turn — it keeps
		// running and is persisted, so it's intact when you switch back. Aborting
		// the fetch stops its onText/onTool callbacks writing into this new
		// conversation. (Contrast stopStreaming, which also tells the server to
		// cancel.)
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setConversationId(id);
		setMessages([]);
		setLoadingConv(true);
		localStorage.setItem(STORAGE_KEY, id);
		try {
			const d = await fetchConversation(id);
			setModelId(d.conversation?.model_id || null);
			setMessages(
				(d.messages || []).map((m) => ({
					id: m.id,
					role: m.role,
					content: blocksToText(m.content),
					parts: blocksToParts(m.content),
					images: blocksToImages(m.content),
				})),
			);
		} catch {
			/* ignore */
		} finally {
			setLoadingConv(false);
			// Picking from the overlay moved focus into (now-unmounted) list; once
			// the conversation has loaded, hand focus back to the composer so the
			// user can type straight away. rAF waits for the re-render to commit.
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, []);

	// Delete a conversation straight from the /sessions list. Optimistically
	// drops it from the list; if it's the open one, reset to a fresh chat.
	const removeConversation = useCallback(
		async (id) => {
			setPickList((prev) => prev.filter((c) => c.id !== id));
			if (id === conversationId) startNewChat();
			try {
				await deleteConversation(id);
			} catch {
				/* ignore */
			}
		},
		[conversationId, startNewChat],
	);

	// Resolve a /title menu choice: auto-rename via the LLM, or manual prompt.
	const runTitleAction = useCallback(
		async (key) => {
			setTitleMenu(false);
			focusInput();
			if (!conversationId) return;
			if (key === "auto") {
				try {
					await retitleConversation(conversationId);
				} catch {
					/* ignore */
				}
				return;
			}
			const t =
				typeof window !== "undefined"
					? window.prompt("Rename conversation")
					: null;
			if (t?.trim()) {
				try {
					await updateConversation({ id: conversationId, title: t.trim() });
				} catch {
					/* ignore */
				}
			}
		},
		[conversationId, focusInput],
	);

	const runCommand = useCallback(
		async (cmd) => {
			if (cmd.kind === "agent") {
				setInput(cmd.prompt || "");
				focusInput();
				return;
			}
			setInput("");
			// Terminal commands don't open a picker, so hand focus straight back to
			// the composer (covers running them via a mouse click on the menu).
			if (cmd.name === "new") {
				startNewChat();
				return focusInput();
			}
			if (cmd.name === "clear") {
				clearMessages();
				return focusInput();
			}
			if (cmd.name === "title") {
				if (!conversationId) return;
				// Offer auto (LLM) vs manual rename instead of jumping to a prompt.
				setTitleActive(0);
				setTitleMenu(true);
				return;
			}
			if (cmd.name === "models") {
				try {
					setPickList(await fetchAllModels());
					setOverlayActive(0);
					setOverlay("models");
				} catch {
					/* ignore */
				}
				return;
			}
			if (cmd.name === "sessions") {
				// The list is loaded (and re-loaded on search) by the debounced
				// effect below, keyed on the open overlay + query.
				setPickList([]);
				setSessionQuery("");
				setOverlayActive(0);
				setSessionsLoading(true);
				sessionsMinUntil.current = Date.now() + 1000;
				setOverlay("sessions");
			}
		},
		[conversationId, startNewChat, clearMessages, focusInput],
	);

	const pickModel = useCallback(
		async (m) => {
			setOverlay(null);
			focusInput();
			setModelId(m.id);
			// Switching to a model that can't see images: drop any pending ones so
			// we don't try to send them to a text-only model.
			if (!m.supports_vision) {
				setPendingImages((curr) => {
					if (curr.length) {
						for (const p of curr)
							if (p.localUrl) URL.revokeObjectURL(p.localUrl);
						pvMessage.info(
							`${m.display_name} can't read images — removed the attached image(s).`,
						);
					}
					return [];
				});
			}
			pvMessage.success(`Model switched to ${m.display_name}`);
			if (conversationId) {
				try {
					await updateConversation({ id: conversationId, model_id: m.id });
				} catch {
					pvMessage.error("Couldn't save the model change");
				}
			}
		},
		[conversationId, focusInput],
	);

	// Shared picker (sessions/models) keyboard nav. Used by both the composer
	// textarea and the sessions search box. Returns true once it handles a key.
	const handleOverlayNav = (e) => {
		if (!overlay) return false;
		// Escape closes the picker even when a search returns no rows.
		if (e.key === "Escape") {
			e.preventDefault();
			setOverlay(null);
			focusInput();
			return true;
		}
		const n = pickList.length;
		if (n === 0) return false;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setOverlayActive((i) => (i + 1) % n);
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setOverlayActive((i) => (i - 1 + n) % n);
			return true;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const item = pickList[Math.min(overlayActive, n - 1)];
			if (overlay === "models") pickModel(item);
			else switchConversation(item.id);
			return true;
		}
		return false;
	};

	const onKeyDown = (e) => {
		if (handleOverlayNav(e)) return;
		// While the /title menu is open, arrows move the highlight, Enter picks,
		// and Escape dismisses it.
		if (titleMenu) {
			const n = TITLE_ACTIONS.length;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setTitleActive((i) => (i + 1) % n);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setTitleActive((i) => (i - 1 + n) % n);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setTitleMenu(false);
				focusInput();
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				runTitleAction(TITLE_ACTIONS[Math.min(titleActive, n - 1)].key);
				return;
			}
		}
		// While the slash menu is open, arrows move the highlight, Enter/Tab run
		// the highlighted command, and Escape dismisses it.
		if (slashMatches.length > 0) {
			const n = slashMatches.length;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSlashActive((i) => (i + 1) % n);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSlashActive((i) => (i - 1 + n) % n);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setInput("");
				focusInput();
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				runCommand(slashMatches[Math.min(slashActive, n - 1)]);
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	};

	// Composer button is state-driven: STOP while streaming with an empty box,
	// otherwise SEND (which injects when streaming, sends a new turn when idle).
	const hasText = input.trim().length > 0;
	const hasReadyImage = pendingImages.some((p) => p.status === "ready");
	const showStop = isStreaming && !hasText;
	// Block send while an upload is in flight so we never send a half-uploaded
	// image (no CDN url yet). Text-only or a ready image both enable send.
	const canSend = (hasText || hasReadyImage) && !uploadingImages;

	return (
		<div className="chat-root chat-panel">
			<div className="chat-header">
				<div className="chat-title">
					<span className="chat-eyebrow">agent /</span>
					{agents.length > 1 ? (
						<select
							className="chat-agent-select"
							value={effectiveAgent}
							onChange={(e) => setAgentKind(e.target.value)}
							title="Agent for new chats"
							style={{
								background: "var(--vp-bg-soft, #15171c)",
								color: "var(--vp-text, #d6dbe5)",
								border: "1px solid var(--vp-border-soft, #2a2f39)",
								padding: "1px 4px",
								fontSize: 11.5,
							}}
						>
							{agents.map((a) => (
								<option key={a.kind} value={a.kind}>
									{a.display_name}
								</option>
							))}
						</select>
					) : (
						<span className="chat-name">{agentLabel}</span>
					)}
				</div>
				<div
					className={`chat-status${isStreaming ? " streaming" : ""}`}
					title={isStreaming ? "streaming" : "idle"}
				>
					<span className="chat-status-dot" />
				</div>
				<button
					type="button"
					className="chat-clear"
					onClick={() => setConfirmClearOpen(true)}
					aria-label="New conversation"
					title="New conversation"
					disabled={messages.length === 0}
				>
					<FormOutlined />
				</button>
				{onClose ? (
					<button
						type="button"
						className="chat-close"
						onClick={onClose}
						aria-label="Close chat"
					>
						×
					</button>
				) : null}
			</div>

			<div className="chat-messages-viewport">
				<div ref={scrollRef} className="chat-messages" onScroll={handleScroll}>
					<div className="chat-messages-inner">
						{loadingConv && messages.length === 0 ? (
							<div className="chat-loading">
								<SpriteRunner pixelSize={3} />
								<span className="chat-loading-label">
									loading conversation…
								</span>
							</div>
						) : messages.length === 0 ? (
							<div className="chat-empty">
								<div className="chat-empty-title">{agentLabel} is ready.</div>
								<div className="chat-empty-sub">
									Ask anything — markdown, code, plans. Streams back token by
									token.
								</div>
							</div>
						) : (
							messages.map((m, i) => {
								const isLast = i === messages.length - 1;
								const streamingThis =
									isStreaming && isLast && m.role === "assistant";
								return m.role === "user" ? (
									<UserBubble
										key={m.id}
										content={m.content}
										context={m.context}
										images={m.images}
									/>
								) : (
									<AssistantBubble
										key={m.id}
										parts={m.parts}
										isStreaming={streamingThis}
										label={agentLabel}
										onNavigate={goTo}
									/>
								);
							})
						)}
					</div>
				</div>
				{showJump ? (
					<button
						type="button"
						className="chat-jump"
						onClick={scrollToBottom}
						title="Jump to latest"
						aria-label="Jump to latest message"
					>
						↓
					</button>
				) : null}
			</div>

			<div className="chat-composer">
				<div className="chat-composer-inner">
					{contextChips.length > 0 ? (
						<div className="chat-context-tags">
							{contextChips.map((chip) => (
								<ContextTag
									key={chip.id}
									label={chip.title}
									title={chip.path || chip.title}
									locked={chip.locked}
									preview={chip.preview}
									onClick={
										chip.locked
											? () => onOpenNote?.(chip.id)
											: () => lockContext(chip.id)
									}
									onRemove={
										chip.locked ? () => unlockContext(chip.id) : undefined
									}
								/>
							))}
						</div>
					) : null}
					{pendingImages.length > 0 ? (
						<div className="chat-image-tags">
							{pendingImages.map((img) => (
								<div
									key={img.id}
									className={`chat-image-tag${img.status === "uploading" ? " is-uploading" : ""}${img.status === "error" ? " is-error" : ""}`}
									title={img.name}
								>
									<img
										className="chat-image-tag-thumb"
										src={img.localUrl || img.url}
										alt={img.name}
									/>
									<span className="chat-image-tag-meta">
										<span className="chat-image-tag-name">{img.name}</span>
										{img.w && img.h ? (
											<span className="chat-image-tag-dim">
												{img.w}×{img.h}
											</span>
										) : null}
									</span>
									{img.status === "uploading" ? (
										<span className="chat-image-tag-spin" aria-hidden="true" />
									) : (
										<button
											type="button"
											className="chat-image-tag-remove"
											onClick={() => removePendingImage(img.id)}
											aria-label={`Remove ${img.name}`}
										>
											×
										</button>
									)}
								</div>
							))}
						</div>
					) : null}
					<div className="chat-composer-fields">
						{slashMatches.length > 0 ? (
							<div className="slash-menu">
								{slashMatches.map((c, i) => (
									<button
										key={`${c.kind}-${c.name}`}
										type="button"
										ref={i === slashActive ? slashActiveRef : null}
										className={`slash-item${i === slashActive ? " is-active" : ""}${c.kind === "agent" ? " slash-item--agent" : ""}`}
										onClick={() => runCommand(c)}
										onMouseEnter={() => setSlashActive(i)}
									>
										<span className="slash-item-name">/{c.name}</span>
										<span className="slash-item-desc">
											{c.description}
											{c.kind === "agent" ? " · agent" : ""}
										</span>
									</button>
								))}
							</div>
						) : null}
						{titleMenu ? (
							<div className="slash-menu">
								{TITLE_ACTIONS.map((a, i) => (
									<button
										key={a.key}
										type="button"
										className={`slash-item${i === titleActive ? " is-active" : ""}`}
										onClick={() => runTitleAction(a.key)}
										onMouseEnter={() => setTitleActive(i)}
									>
										<span className="slash-item-name">{a.label}</span>
										<span className="slash-item-desc">{a.desc}</span>
									</button>
								))}
							</div>
						) : null}
						{overlay ? (
							<div className="picker-overlay">
								<div className="picker-head">
									<span className="picker-dots" aria-hidden="true">
										<span />
										<span />
										<span />
									</span>
									<strong className="picker-title">
										{overlay === "models"
											? "Pick a model"
											: "Switch conversation"}
									</strong>
									<button
										type="button"
										className="picker-close"
										onClick={() => {
											setOverlay(null);
											focusInput();
										}}
									>
										×
									</button>
								</div>
								{overlay === "sessions" ? (
									<input
										className="picker-search"
										type="text"
										value={sessionQuery}
										onChange={(e) => setSessionQuery(e.target.value)}
										onKeyDown={handleOverlayNav}
										placeholder="Search title or message text…"
										// biome-ignore lint/a11y/noAutofocus: focus the search box when the picker opens
										autoFocus
									/>
								) : null}
								<div className="picker-list">
									{overlay === "sessions" && sessionsLoading ? (
										<div className="picker-loading">
											<SpriteRunner pixelSize={2} />
											<span className="picker-loading-label">loading…</span>
										</div>
									) : pickList.length === 0 ? (
										<div className="picker-empty">None</div>
									) : overlay === "models" ? (
										pickList.map((m, i) => {
											// The model actually in use: the conversation's override,
											// or — when it has none — the default (what the backend
											// falls back to). That one gets the ◆ marker.
											const inUse = modelId ? m.id === modelId : m.is_default;
											return (
												<button
													key={m.id}
													type="button"
													ref={i === overlayActive ? overlayActiveRef : null}
													className={`picker-item${i === overlayActive ? " is-active" : ""}${inUse ? " is-current" : ""}`}
													onClick={() => pickModel(m)}
													onMouseEnter={() => setOverlayActive(i)}
												>
													<span className="picker-item-mark" aria-hidden="true">
														{inUse ? "◆" : ""}
													</span>
													{m.display_name}{" "}
													<span className="picker-item-meta">
														{m.provider}
														{m.is_default ? " · default" : ""}
													</span>
												</button>
											);
										})
									) : (
										pickList.map((c, i) => (
											<div
												key={c.id}
												ref={i === overlayActive ? overlayActiveRef : null}
												className={`picker-row${i === overlayActive ? " is-active" : ""}`}
											>
												<button
													type="button"
													className="picker-item ellipsis"
													onClick={() => switchConversation(c.id)}
													onMouseEnter={() => setOverlayActive(i)}
												>
													{c.title || "Untitled"}
												</button>
												<button
													type="button"
													className="picker-del"
													onClick={() => removeConversation(c.id)}
													onMouseEnter={() => setOverlayActive(i)}
													aria-label="Delete conversation"
													title="Delete conversation"
												>
													<DeleteOutlined />
												</button>
											</div>
										))
									)}
								</div>
							</div>
						) : null}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for image attachments */}
						<div
							className="chat-composer-row"
							onDrop={onDrop}
							onDragOver={(e) => {
								if (visionEnabled) e.preventDefault();
							}}
						>
							{visionEnabled ? (
								<>
									<input
										ref={fileInputRef}
										type="file"
										accept="image/*"
										multiple
										hidden
										onChange={(e) => {
											for (const f of e.target.files || []) addImageFile(f);
											e.target.value = "";
										}}
									/>
									<button
										type="button"
										className="chat-attach"
										onClick={() => fileInputRef.current?.click()}
										title="Attach an image"
										aria-label="Attach an image"
									>
										📎
									</button>
								</>
							) : null}
							<textarea
								ref={inputRef}
								className="chat-input"
								value={input}
								onChange={(e) => {
									setInput(e.target.value);
									setSlashActive(0);
									setTitleMenu(false);
								}}
								onKeyDown={onKeyDown}
								onPaste={onPaste}
								placeholder={
									compact
										? `Ask ${agentLabel}…`
										: `Ask ${agentLabel} anything...`
								}
								rows={1}
							/>
							{showStop ? (
								<button
									type="button"
									className="chat-send chat-stop"
									onClick={stopStreaming}
									title="Stop the agent"
								>
									stop ◼
								</button>
							) : (
								<button
									type="button"
									className="chat-send"
									onClick={sendMessage}
									disabled={!canSend}
								>
									send ↑
								</button>
							)}
						</div>
					</div>
				</div>
			</div>

			<PvModal
				open={confirmClearOpen}
				title="Start a new conversation?"
				confirmText="New chat"
				cancelText="Cancel"
				danger
				onConfirm={confirmClear}
				onCancel={() => setConfirmClearOpen(false)}
			>
				This starts a fresh chat. The current conversation stays saved but won't
				be shown here anymore.
			</PvModal>
		</div>
	);
}
