import { DeleteOutlined } from "@ant-design/icons";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PvButton, PvModal } from "@/admin/components/ui";
import { streamChat } from "../api/openclawChat";
import { useServices } from "../queries";
import useNotesWorkspaceStore from "../store/notesWorkspaceStore";
import PiumaRunning from "./PiumaRunning";
import "./ChatPage.css";

// Bumping this key invalidates persisted chats — change it if the message
// shape ever changes in a breaking way. v2: user messages carry a separate
// `context` array instead of inlining "vault path:" lines into `content`.
const STORAGE_KEY = "openclaw_chat_history_v2";

const ASSISTANT_LABEL = "openclaw stream";
const SUBMIT_LABEL = "ask claw";

// Last path segment, used as the compact chip label (full path lives in the
// title attr). Falls back to the raw path if there's no separator.
const noteLabel = (path) => path.split("/").filter(Boolean).pop() || path;

// Escape a path for safe use inside an XML attribute value.
const escapeXmlAttr = (value) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

// Wrap a turn's text with its attached notes as a structured <context> block
// so the gateway gets clear, parseable delimiters instead of a loose prefix.
const withContextBlock = (content, context) => {
	if (!context?.length) return content;
	const notes = context
		.map((p) => `  <note path="${escapeXmlAttr(p)}" />`)
		.join("\n");
	return `<context>\n${notes}\n</context>\n\n${content}`;
};

const newMessageId = () =>
	`msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Compact one-line summary of a tool call's args object, e.g.
// `{ query: "16khz" }` → `query: "16khz"`. Long values are clipped.
const summarizeToolArgs = (args) => {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args)
		.map(([k, v]) => {
			const raw = typeof v === "string" ? v : JSON.stringify(v);
			const clipped = raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
			return `${k}: ${clipped}`;
		})
		.join(", ");
};

// Fold a `tool`-stream event into the assistant message's tool list, keyed by
// toolCallId: `start` adds a running entry, `result` flips it to done/error.
const applyToolEvent = (tools = [], evt) => {
	const id = evt.toolCallId || evt.name;
	const idx = tools.findIndex((t) => t.id === id);
	if (evt.phase === "result") {
		if (idx < 0) return tools;
		const next = [...tools];
		next[idx] = { ...next[idx], status: evt.isError ? "error" : "done" };
		return next;
	}
	const entry = {
		id,
		name: evt.name || "tool",
		args: summarizeToolArgs(evt.args),
		status: "running",
	};
	if (idx < 0) return [...tools, entry];
	const next = [...tools];
	// Keep a terminal status if a stray start/update arrives after the result.
	const prev = next[idx];
	next[idx] =
		prev.status === "done" || prev.status === "error"
			? { ...prev, ...entry, status: prev.status }
			: { ...prev, ...entry };
	return next;
};

const TOOL_GLYPH = { running: "⛏", done: "✓", error: "✕" };

// Persistent list of tools the agent ran/is running for one assistant turn.
function ToolActivity({ tools }) {
	if (!tools?.length) return null;
	return (
		<div className="chat-tools">
			{tools.map((t) => (
				<div key={t.id} className={`chat-tool chat-tool--${t.status}`}>
					<span className="chat-tool-icon" aria-hidden="true">
						{TOOL_GLYPH[t.status] || "⛏"}
					</span>
					<span className="chat-tool-name">{t.name}</span>
					{t.args ? <span className="chat-tool-args">{t.args}</span> : null}
				</div>
			))}
		</div>
	);
}

// One context chip. Two states (Copilot-style):
//   • transient — derived from an open tab, dimmed; `onClick` locks it in.
//   • locked    — pinned into context, solid; `onRemove` unlocks it.
// A transient chip whose source tab is a PREVIEW tab renders italic, mirroring
// the editor tab strip — `preview` only matters while the chip isn't locked.
// Read-only chips inside a sent bubble pass neither handler.
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

function UserBubble({ content, context }) {
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
				{content ? <div className="chat-user-text">{content}</div> : null}
			</div>
		</div>
	);
}

function AssistantBubble({ content, tools, isStreaming }) {
	const empty = !content;
	return (
		<div className="chat-assistant-row">
			<span className="chat-role">{ASSISTANT_LABEL}</span>
			<div className="chat-assistant-body">
				<ToolActivity tools={tools} />
				{empty && isStreaming ? (
					<div className="chat-thinking">
						<PiumaRunning pixelSize={2} />
						<div className="chat-thinking-body">
							<span className="chat-thinking-label">
								openclaw is sniffing the trail
							</span>
							<span className="chat-thinking-dots" aria-hidden="true">
								<i />
								<i />
								<i />
							</span>
						</div>
					</div>
				) : (
					<>
						<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
						{isStreaming ? <span className="chat-cursor" /> : null}
					</>
				)}
			</div>
		</div>
	);
}

// Embedded chat panel — same wiring as the old /admin/chat page minus the
// route chrome (no back link, no title-bar navigation). The `onClose` prop
// hides the panel; the host (NotesLayout) owns the open/closed state.
export default function ChatPanel({ onClose, onOpenNote }) {
	const [messages, setMessages] = useState([]);
	const [input, setInput] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const [hydrated, setHydrated] = useState(false);
	const [confirmClearOpen, setConfirmClearOpen] = useState(false);
	const [compact, setCompact] = useState(false);
	const scrollRef = useRef(null);
	const abortRef = useRef(null);
	const inputRef = useRef(null);

	// OpenClaw config lives in the DB now. Until services load we assume it's
	// configured (avoid a flash); once loaded, a missing gateway URL means chat
	// can't work, so we surface a banner and block sending.
	const { data: services } = useServices();
	const openclawConfigured = services ? Boolean(services.openclaw_url) : true;

	// Track the composer width so a narrow panel can swap to a shorter
	// placeholder instead of letting the long one wrap onto two lines.
	useEffect(() => {
		const el = inputRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(([entry]) => {
			setCompact(entry.contentRect.width < 240);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Auto-grow the composer with its content: collapse to measure the real
	// scrollHeight, then set it as the height. CSS caps it at 5 lines and
	// switches on scrolling past that.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the input text changes
	useLayoutEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [input]);

	const openTabs = useNotesWorkspaceStore((s) => s.tabs);
	const lockedContext = useNotesWorkspaceStore((s) => s.lockedContext);
	const lockContext = useNotesWorkspaceStore((s) => s.lockContext);
	const unlockContext = useNotesWorkspaceStore((s) => s.unlockContext);

	// Chat context chips, derived from the workspace, in display order:
	//   1. locked notes (pinned) first, shown solid — these are the context sent.
	//   2. then unlocked open tabs, shown transient/dim — click to lock in. These
	//      keep their tab (open) order, i.e. by the time each note was opened;
	//      the active note is NOT hoisted to the front. Closing a tab drops its
	//      transient chip; locked ones stay.
	const contextChips = useMemo(() => {
		const lockedIds = new Set(lockedContext.map((t) => t.id));
		const unlocked = openTabs.filter((t) => !lockedIds.has(t.id));
		return [
			...lockedContext.map((t) => ({ ...t, locked: true })),
			...unlocked.map((t) => ({ ...t, locked: false })),
		];
	}, [openTabs, lockedContext]);

	// Only locked (selected) notes with a known path are sent as context.
	const sentContextPaths = useMemo(
		() => lockedContext.map((t) => t.path).filter(Boolean),
		[lockedContext],
	);

	useEffect(() => () => abortRef.current?.abort(), []);

	useEffect(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) setMessages(parsed);
			}
		} catch (e) {
			console.warn("[chat] failed to parse stored history", e);
		}
		setHydrated(true);
	}, []);

	useEffect(() => {
		if (!hydrated || isStreaming) return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
		} catch (e) {
			console.warn("[chat] failed to persist history", e);
		}
	}, [messages, isStreaming, hydrated]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll-to-bottom must fire when messages change
	useEffect(() => {
		if (!scrollRef.current) return;
		scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [messages]);

	const handleClear = useCallback(() => {
		setConfirmClearOpen(true);
	}, []);

	const confirmClear = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setMessages([]);
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch (e) {
			console.warn("[chat] failed to clear stored history", e);
		}
		setConfirmClearOpen(false);
	}, []);

	const sendMessage = useCallback(async () => {
		const text = input.trim();
		if (!text || isStreaming) return;

		// Snapshot the locked context paths onto the message so its bubble can
		// render them as chips. Locked notes stay pinned for the next turn too,
		// so we don't clear anything here.
		const userMsg = {
			id: newMessageId(),
			role: "user",
			content: text,
			...(sentContextPaths.length ? { context: sentContextPaths } : {}),
		};
		const assistantMsg = {
			id: newMessageId(),
			role: "assistant",
			content: "",
			tools: [],
		};
		const history = [...messages, userMsg];
		setMessages([...history, assistantMsg]);
		setInput("");
		setIsStreaming(true);

		const controller = new AbortController();
		abortRef.current = controller;

		// Fold each turn's context into a structured <context> block on the wire
		// so the gateway gets clear delimiters, while the stored/displayed
		// content stays clean.
		const wireHistory = history.map(({ role, content, context }) => ({
			role,
			content: withContextBlock(content, context),
		}));

		await streamChat({
			messages: wireHistory,
			signal: controller.signal,
			onToken: (delta) => {
				setMessages((curr) => {
					const updated = [...curr];
					const last = updated[updated.length - 1];
					updated[updated.length - 1] = {
						...last,
						content: last.content + delta,
					};
					return updated;
				});
			},
			onTool: (evt) => {
				setMessages((curr) => {
					const updated = [...curr];
					const last = updated[updated.length - 1];
					updated[updated.length - 1] = {
						...last,
						tools: applyToolEvent(last.tools, evt),
					};
					return updated;
				});
			},
			onError: (e) => {
				setMessages((curr) => {
					const updated = [...curr];
					const last = updated[updated.length - 1];
					updated[updated.length - 1] = {
						...last,
						content: `**Error:** ${e.message}`,
					};
					return updated;
				});
			},
		});

		setIsStreaming(false);
		abortRef.current = null;
	}, [input, isStreaming, messages, sentContextPaths]);

	const onKeyDown = (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	};

	const canSend = input.trim().length > 0 && !isStreaming && openclawConfigured;

	return (
		<div className="chat-root chat-panel">
			<div className="chat-header">
				<div className="chat-title">
					<span className="chat-eyebrow">llm brief /</span>
					<span className="chat-name">OpenClaw</span>
				</div>
				<div
					className={`chat-status${isStreaming ? " streaming" : ""}`}
					title={isStreaming ? "streaming" : "idle"}
				>
					<span className="chat-status-dot" />
				</div>
				{messages.length > 0 ? (
					<button
						type="button"
						className="chat-clear"
						onClick={handleClear}
						aria-label="Clear conversation"
						title="Clear conversation"
					>
						<DeleteOutlined />
					</button>
				) : null}
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

			{!openclawConfigured ? (
				<div className="chat-config-alert" role="alert">
					<div className="chat-config-alert-text">
						<strong>OpenClaw isn't configured</strong>
						<span>Add the gateway URL &amp; token to start chatting.</span>
					</div>
					<PvButton to="/admin/services" size="sm" variant="accent">
						Configure
					</PvButton>
				</div>
			) : null}

			<div ref={scrollRef} className="chat-messages">
				<div className="chat-messages-inner">
					{messages.length === 0 ? (
						<div className="chat-empty">
							<div className="chat-empty-title">Claw is on the leash.</div>
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
								/>
							) : (
								<AssistantBubble
									key={m.id}
									content={m.content}
									tools={m.tools}
									isStreaming={streamingThis}
								/>
							);
						})
					)}
				</div>
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
					<div className="chat-composer-row">
						<textarea
							ref={inputRef}
							className="chat-input"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={onKeyDown}
							placeholder={compact ? "Ask Claw…" : "Ask Claw about anything..."}
							rows={1}
						/>
						<button
							type="button"
							className="chat-send"
							onClick={sendMessage}
							disabled={!canSend}
						>
							{isStreaming ? "…" : `${SUBMIT_LABEL} ↑`}
						</button>
					</div>
				</div>
			</div>

			<PvModal
				open={confirmClearOpen}
				title="Clear conversation?"
				confirmText="Clear"
				cancelText="Cancel"
				danger
				onConfirm={confirmClear}
				onCancel={() => setConfirmClearOpen(false)}
			>
				This deletes all messages on this device.
			</PvModal>
		</div>
	);
}
