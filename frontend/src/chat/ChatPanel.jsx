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
import { PvModal } from "@/admin/components/ui";
import {
	createConversation,
	fetchAllModels,
	fetchConversation,
	fetchConversations,
	streamChat,
	updateConversation,
} from "../api/agentChatApi";
import { useAgentList, useDefaultAgent } from "../queries";

// Universal client commands (same for every agent). Agent-specific commands are
// the prompt macros from db_agent_profiles.commands, merged in at render time.
const CLIENT_COMMANDS = [
	{ name: "new", description: "Start a new conversation" },
	{ name: "clear", description: "Start a new conversation" },
	{ name: "sessions", description: "Switch to another conversation" },
	{ name: "models", description: "Pick the model for this chat" },
	{ name: "title", description: "Rename this conversation" },
];

import useNotesWorkspaceStore from "../store/notesWorkspaceStore";
import PiumaRunning from "./PiumaRunning";
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

// Derive the per-turn tool activity from persisted content blocks: each
// `tool_use` becomes a chip; the following `tool_result` sets its status.
const blocksToTools = (content) => {
	if (!Array.isArray(content)) return [];
	const tools = [];
	for (const b of content) {
		if (b.type === "tool_use") {
			tools.push({
				id: String(tools.length),
				name: b.name,
				args: b.input,
				status: "done",
			});
		} else if (b.type === "tool_result") {
			const t = [...tools].reverse().find((x) => x.name === b.name);
			if (t) {
				const out = b.output;
				const isErr = out && typeof out === "object" && "error" in out;
				t.status = isErr ? "error" : "done";
			}
		}
	}
	return tools;
};

const TOOL_ICON = { running: "⚙", done: "✓", error: "✗" };

// Compact one-line summary of a tool's arguments for the chip.
const toolArgsSummary = (args) => {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args)
		.filter(([, v]) => v !== null && v !== undefined && v !== "")
		.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
		.join(", ");
};

// Group tools by name for the collapsed summary line, busiest first —
// e.g. "9× search notes · 4× read note · 1× browse folder".
const toolSummary = (tools) => {
	const counts = new Map();
	for (const t of tools) counts.set(t.name, (counts.get(t.name) || 0) + 1);
	const parts = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([name, n]) => `${n}× ${name.replace(/_/g, " ")}`);
	const shown = parts.slice(0, 4).join(" · ");
	return parts.length > 4 ? `${shown} · +${parts.length - 4} more` : shown;
};

function ToolList({ tools, isStreaming }) {
	const [expanded, setExpanded] = useState(false);
	if (!tools?.length) return null;
	const anyErr = tools.some((t) => t.status === "error");

	const list = (
		<div className="chat-tools">
			{tools.map((t) => {
				const summary = toolArgsSummary(t.args);
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

	// Live: show the full activity as it streams. Once the turn settles it
	// collapses to a one-line summary you can click to re-expand.
	if (isStreaming) return list;
	return (
		<div className="chat-tools-wrap">
			<button
				type="button"
				className={`chat-tools-summary ${anyErr ? "chat-tools-summary--error" : ""}`}
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				<span className="chat-tools-caret" aria-hidden="true">
					{expanded ? "▾" : "▸"}
				</span>
				<span className="chat-tools-summary-icon" aria-hidden="true">
					🔧
				</span>
				<span className="chat-tools-summary-text">
					{tools.length} tool{tools.length === 1 ? "" : "s"} ·{" "}
					{toolSummary(tools)}
				</span>
				<span className="chat-tool-icon" aria-hidden="true">
					{anyErr ? "✗" : "✓"}
				</span>
			</button>
			{expanded ? list : null}
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

function AssistantBubble({ content, tools, isStreaming, label }) {
	const empty = !content;
	return (
		<div className="chat-assistant-row">
			<span className="chat-role">{label}</span>
			<div className="chat-assistant-body">
				<ToolList tools={tools} isStreaming={isStreaming} />
				{empty && isStreaming ? (
					<div className="chat-thinking">
						<PiumaRunning pixelSize={2} />
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
						<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
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
	const [conversationId, setConversationId] = useState(
		() => localStorage.getItem(STORAGE_KEY) || null,
	);
	// Only restore when a stored conversation exists; a fresh panel (and any
	// conversation created later this session) starts already-hydrated so the
	// restore effect never clobbers live streaming state.
	const [hydrated, setHydrated] = useState(
		() => !localStorage.getItem(STORAGE_KEY),
	);
	const scrollRef = useRef(null);
	const abortRef = useRef(null);
	const inputRef = useRef(null);

	// Restore the stored conversation once on mount.
	useEffect(() => {
		if (hydrated || !conversationId) return;
		let cancelled = false;
		fetchConversation(conversationId)
			.then((d) => {
				if (cancelled) return;
				setMessages(
					(d.messages || []).map((m) => ({
						id: m.id,
						role: m.role,
						content: blocksToText(m.content),
						tools: blocksToTools(m.content),
					})),
				);
				setHydrated(true);
			})
			.catch(() => {
				localStorage.removeItem(STORAGE_KEY);
				setConversationId(null);
				setHydrated(true);
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
		el.style.height = `${el.scrollHeight}px`;
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

	useEffect(() => () => abortRef.current?.abort(), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
	useEffect(() => {
		if (!scrollRef.current) return;
		scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [messages]);

	const confirmClear = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setMessages([]);
		setConversationId(null);
		localStorage.removeItem(STORAGE_KEY);
		setConfirmClearOpen(false);
	}, []);

	const sendMessage = useCallback(async () => {
		const text = input.trim();
		if (!text || isStreaming) return;

		let convId = conversationId;
		if (!convId) {
			try {
				const conv = await createConversation({ agent: effectiveAgent });
				convId = conv.id;
				setConversationId(conv.id);
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
		};
		const assistantMsg = {
			id: newMessageId(),
			role: "assistant",
			content: "",
			tools: [],
		};
		setMessages((curr) => [...curr, userMsg, assistantMsg]);
		setInput("");
		setIsStreaming(true);

		const controller = new AbortController();
		abortRef.current = controller;

		try {
			await streamChat({
				conversationId: convId,
				message: text,
				contextNoteIds: sentContextIds,
				signal: controller.signal,
				onText: (delta) =>
					setMessages((curr) => {
						const updated = [...curr];
						const last = updated[updated.length - 1];
						updated[updated.length - 1] = {
							...last,
							content: last.content + delta,
						};
						return updated;
					}),
				onThinking: () => {},
				onTool: (t) =>
					setMessages((curr) => {
						const updated = [...curr];
						const last = { ...updated[updated.length - 1] };
						const tools = [...(last.tools || [])];
						if (t.done) {
							const idx = tools.findIndex((x) => x.id === t.id);
							if (idx >= 0)
								tools[idx] = {
									...tools[idx],
									status: t.ok ? "done" : "error",
								};
						} else {
							tools.push({
								id: t.id,
								name: t.name,
								args: t.args,
								status: "running",
							});
						}
						last.tools = tools;
						updated[updated.length - 1] = last;
						return updated;
					}),
				onError: (e) =>
					setMessages((curr) => {
						const updated = [...curr];
						const last = updated[updated.length - 1];
						updated[updated.length - 1] = {
							...last,
							content: `**Error:** ${e.message}`,
						};
						return updated;
					}),
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

	const startNewChat = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setMessages([]);
		setConversationId(null);
		localStorage.removeItem(STORAGE_KEY);
		setInput("");
	}, []);

	const switchConversation = useCallback(async (id) => {
		setOverlay(null);
		setConversationId(id);
		localStorage.setItem(STORAGE_KEY, id);
		try {
			const d = await fetchConversation(id);
			setMessages(
				(d.messages || []).map((m) => ({
					id: m.id,
					role: m.role,
					content: blocksToText(m.content),
					tools: blocksToTools(m.content),
				})),
			);
		} catch {
			/* ignore */
		}
	}, []);

	const runCommand = useCallback(
		async (cmd) => {
			if (cmd.kind === "agent") {
				setInput(cmd.prompt || "");
				inputRef.current?.focus();
				return;
			}
			setInput("");
			if (cmd.name === "new" || cmd.name === "clear") return startNewChat();
			if (cmd.name === "title") {
				if (!conversationId) return;
				const t =
					typeof window !== "undefined"
						? window.prompt("Rename conversation")
						: null;
				if (t) {
					try {
						await updateConversation({ id: conversationId, title: t });
					} catch {
						/* ignore */
					}
				}
				return;
			}
			if (cmd.name === "models") {
				try {
					setPickList(await fetchAllModels());
					setOverlay("models");
				} catch {
					/* ignore */
				}
				return;
			}
			if (cmd.name === "sessions") {
				try {
					setPickList(await fetchConversations());
					setOverlay("sessions");
				} catch {
					/* ignore */
				}
			}
		},
		[conversationId, startNewChat],
	);

	const pickModel = useCallback(
		async (m) => {
			setOverlay(null);
			if (conversationId) {
				try {
					await updateConversation({ id: conversationId, model_id: m.id });
				} catch {
					/* ignore */
				}
			}
		},
		[conversationId],
	);

	const onKeyDown = (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (slashMatches.length > 0) {
				runCommand(slashMatches[0]);
				return;
			}
			sendMessage();
		}
	};

	const canSend = input.trim().length > 0 && !isStreaming;

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
								padding: "2px 6px",
								fontSize: 13,
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
				{messages.length > 0 ? (
					<button
						type="button"
						className="chat-clear"
						onClick={() => setConfirmClearOpen(true)}
						aria-label="New conversation"
						title="New conversation"
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

			<div ref={scrollRef} className="chat-messages">
				<div className="chat-messages-inner">
					{messages.length === 0 ? (
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
								/>
							) : (
								<AssistantBubble
									key={m.id}
									content={m.content}
									tools={m.tools}
									isStreaming={streamingThis}
									label={agentLabel}
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
					{slashMatches.length > 0 ? (
						<div
							style={{
								background: "var(--vp-panel,#1b1e25)",
								border: "1px solid var(--vp-border-soft,#2a2f39)",
								marginBottom: 6,
								maxHeight: 200,
								overflowY: "auto",
							}}
						>
							{slashMatches.map((c) => (
								<button
									key={`${c.kind}-${c.name}`}
									type="button"
									onClick={() => runCommand(c)}
									style={{
										display: "block",
										width: "100%",
										textAlign: "left",
										background: "none",
										border: "none",
										color: "var(--vp-text,#d6dbe5)",
										padding: "6px 10px",
										cursor: "pointer",
										fontFamily: "inherit",
										fontSize: 13,
									}}
								>
									<span style={{ color: "var(--vp-accent-2,#5cd0a9)" }}>
										/{c.name}
									</span>
									<span
										style={{
											color: "var(--vp-muted,#8a93a3)",
											marginLeft: 8,
											fontSize: 12,
										}}
									>
										{c.description}
										{c.kind === "agent" ? " · agent" : ""}
									</span>
								</button>
							))}
						</div>
					) : null}
					{overlay ? (
						<div
							style={{
								background: "var(--vp-panel,#1b1e25)",
								border: "1px solid var(--vp-border-soft,#2a2f39)",
								marginBottom: 6,
								maxHeight: 240,
								overflowY: "auto",
								padding: 8,
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									marginBottom: 6,
								}}
							>
								<strong
									style={{ fontSize: 12, color: "var(--vp-muted,#8a93a3)" }}
								>
									{overlay === "models"
										? "Pick a model"
										: "Switch conversation"}
								</strong>
								<button
									type="button"
									onClick={() => setOverlay(null)}
									style={{
										background: "none",
										border: "none",
										color: "var(--vp-muted,#8a93a3)",
										cursor: "pointer",
										fontSize: 16,
									}}
								>
									×
								</button>
							</div>
							{pickList.length === 0 ? (
								<div style={{ color: "var(--vp-faint,#5b6373)", fontSize: 12 }}>
									None
								</div>
							) : overlay === "models" ? (
								pickList.map((m) => (
									<button
										key={m.id}
										type="button"
										onClick={() => pickModel(m)}
										style={{
											display: "block",
											width: "100%",
											textAlign: "left",
											background: "none",
											border: "none",
											color: "var(--vp-text,#d6dbe5)",
											padding: "5px 8px",
											cursor: "pointer",
											fontFamily: "inherit",
											fontSize: 13,
										}}
									>
										{m.display_name}{" "}
										<span
											style={{ color: "var(--vp-muted,#8a93a3)", fontSize: 12 }}
										>
											{m.provider}
											{m.is_default ? " · default" : ""}
										</span>
									</button>
								))
							) : (
								pickList.map((c) => (
									<button
										key={c.id}
										type="button"
										onClick={() => switchConversation(c.id)}
										style={{
											display: "block",
											width: "100%",
											textAlign: "left",
											background: "none",
											border: "none",
											color: "var(--vp-text,#d6dbe5)",
											padding: "5px 8px",
											cursor: "pointer",
											fontFamily: "inherit",
											fontSize: 13,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
									>
										{c.title || "Untitled"}
									</button>
								))
							)}
						</div>
					) : null}
					<div className="chat-composer-row">
						<textarea
							ref={inputRef}
							className="chat-input"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={onKeyDown}
							placeholder={
								compact ? `Ask ${agentLabel}…` : `Ask ${agentLabel} anything...`
							}
							rows={1}
						/>
						<button
							type="button"
							className="chat-send"
							onClick={sendMessage}
							disabled={!canSend}
						>
							{isStreaming ? "…" : "send ↑"}
						</button>
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
