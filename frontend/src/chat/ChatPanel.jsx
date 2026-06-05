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
	fetchConversation,
	streamChat,
} from "../api/agentChatApi";
import { useAgentList, useDefaultAgent } from "../queries";
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

function AssistantBubble({ content, isStreaming, label }) {
	const empty = !content;
	return (
		<div className="chat-assistant-row">
			<span className="chat-role">{label}</span>
			<div className="chat-assistant-body">
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
	const [conversationId, setConversationId] = useState(
		() => localStorage.getItem(STORAGE_KEY) || null,
	);
	const [hydrated, setHydrated] = useState(false);
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
		const assistantMsg = { id: newMessageId(), role: "assistant", content: "" };
		setMessages((curr) => [...curr, userMsg, assistantMsg]);
		setInput("");
		setIsStreaming(true);

		const controller = new AbortController();
		abortRef.current = controller;

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
			onDone: () => {},
		});

		setIsStreaming(false);
		abortRef.current = null;
	}, [
		input,
		isStreaming,
		conversationId,
		effectiveAgent,
		sentContextPaths,
		sentContextIds,
	]);

	const onKeyDown = (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
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
