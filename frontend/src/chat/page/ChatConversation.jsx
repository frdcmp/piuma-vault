import {
	BulbOutlined,
	DownOutlined,
	EyeOutlined,
	ToolOutlined,
} from "@ant-design/icons";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { pvMessage } from "@/admin/components/ui";
import {
	clearConversation,
	createConversation,
	fetchConversation,
	injectMessage,
	retitleConversation,
	stopConversation,
	streamChat,
	switchBranch,
	updateConversation,
} from "../../api/agentChatApi";
import { useAgentList, useDefaultAgent } from "../../queries";
import { formatDateTime, timeAgo } from "../../utils/dateTime";
import MessageList from "../components/MessageList";
import PendingImages from "../components/PendingImages";
import SlashMenu from "../components/SlashMenu";
import {
	appendTextPart,
	mapServerMessage,
	newMessageId,
} from "../engine/messageModel";
import useChatScroll from "../engine/useChatScroll";
import useChatStream from "../engine/useChatStream";
import useImageUpload from "../engine/useImageUpload";
import useModelCatalog from "../engine/useModelCatalog";

// Universal client commands (same for every agent). Agent-specific commands are
// the prompt macros from the agent profile, merged in at render time.
const CLIENT_COMMANDS = [
	{ name: "new", description: "Start a new conversation" },
	{ name: "clear", description: "Wipe this conversation's messages" },
	{ name: "sessions", description: "Toggle the conversation list" },
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

// Slash-menu items derived from a list of matched commands.
const slashItems = (matches) =>
	matches.map((c) => ({
		key: `${c.kind}-${c.name}`,
		name: `/${c.name}`,
		desc: `${c.description}${c.kind === "agent" ? " · agent" : ""}`,
		agent: c.kind === "agent",
	}));

const titleItems = TITLE_ACTIONS.map((a) => ({
	key: a.key,
	name: a.label,
	desc: a.desc,
}));

// Center column: the conversation itself. Loads `conversationId` (null = a fresh
// chat), streams turns, renders tools inline, and exposes a header model picker.
// Lifts a freshly-created conversation id + any list-affecting change up to the
// page so the sidebar stays in sync.
export default function ChatConversation({
	conversationId,
	onConversationCreated,
	onConversationsChanged,
	onToggleSidebar,
	onNewChat,
}) {
	const navigate = useNavigate();
	const { data: agents = [] } = useAgentList();
	const { data: def } = useDefaultAgent();
	const effectiveAgent = def?.agent || "vault_agent";
	const agentLabel =
		agents.find((a) => a.kind === effectiveAgent)?.display_name || "Piuma";

	const [messages, setMessages] = useState([]);
	const [input, setInput] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const [sending, setSending] = useState(false);
	const [loadingConv, setLoadingConv] = useState(false);
	const [title, setTitle] = useState(null);
	// { created_at, updated_at } of the loaded conversation, for the header line.
	const [meta, setMeta] = useState(null);

	// The model bound to the conversation (or null → backend default).
	const [modelId, setModelId] = useState(null);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);

	// Slash-command menu (client commands + the agent's macros) and the `/title`
	// two-option submenu.
	const [slashActive, setSlashActive] = useState(0);
	const [titleMenu, setTitleMenu] = useState(false);
	const [titleActive, setTitleActive] = useState(0);

	// Which user message is being edited (for fork-on-send), and its draft text.
	const [editingId, setEditingId] = useState(null);
	const [editText, setEditText] = useState("");

	// The conversation actually loaded/displayed, as a ref. Async writers bail if
	// the user switched away, and the load effect uses it to tell an EXTERNAL
	// switch (sidebar / new-chat) apart from the id we mint ourselves mid-send —
	// the latter must NOT reset the live stream. Seeded null so the first real id
	// (mount restore) still loads.
	const convRef = useRef(null);

	const abortRef = useRef(null);
	const inputRef = useRef(null);
	const fileRef = useRef(null);

	const focusInput = useCallback(() => {
		requestAnimationFrame(() => inputRef.current?.focus());
	}, []);

	// Single navigation entry point for chat links / "Go" actions.
	const goTo = useCallback(
		(to) => {
			if (!to) return;
			if (/^https?:\/\//i.test(to)) {
				window.open(to, "_blank", "noopener,noreferrer");
				return;
			}
			if (to.startsWith("/")) navigate(to);
		},
		[navigate],
	);

	// Shared engine pieces.
	const { scrollRef, showJump, handleScroll, scrollToBottom } =
		useChatScroll(messages);
	const {
		allModels,
		activeModel,
		visionEnabled,
		activeModelRef,
		modelLabelFor,
	} = useModelCatalog(modelId);
	const {
		pendingImages,
		setPendingImages,
		uploadingImages,
		addImageFile,
		removePendingImage,
		onPaste,
		onDrop,
	} = useImageUpload({ visionEnabled, convRef });
	const { buildHandlers, reloadActivePath } = useChatStream({
		convRef,
		setMessages,
		setIsStreaming,
		activeModelRef,
	});

	// ── Load / reset on EXTERNAL conversation switch ────────────────────────────
	useEffect(() => {
		// Ignore the prop catching up to an id we just created ourselves (mid-send);
		// resetting here would kill the stream that's still writing into the bubble.
		if (conversationId === convRef.current) return;
		convRef.current = conversationId;
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setInput("");
		setMessages([]);
		setModelId(null);
		setTitle(null);
		setMeta(null);
		if (!conversationId) {
			setLoadingConv(false);
			return;
		}
		let cancelled = false;
		setLoadingConv(true);
		fetchConversation(conversationId)
			.then((d) => {
				if (cancelled) return;
				setModelId(d.conversation?.model_id || null);
				setTitle(d.conversation?.title || null);
				setMeta({
					created_at: d.conversation?.created_at || null,
					updated_at: d.conversation?.updated_at || null,
				});
				setMessages((d.messages || []).map(mapServerMessage));
			})
			.catch(() => {})
			.finally(() => {
				if (!cancelled) setLoadingConv(false);
				focusInput();
			});
		return () => {
			cancelled = true;
		};
	}, [conversationId, focusInput]);

	// Auto-grow the textarea up to its max-height.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on text change
	useLayoutEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [input]);

	useEffect(() => () => abortRef.current?.abort(), []);

	// ── Send ─────────────────────────────────────────────────────────────────
	const sendMessage = useCallback(async () => {
		const text = input.trim();
		const readyImages = pendingImages.filter(
			(p) => p.status === "ready" && p.url,
		);
		if (!text && !readyImages.length) return;
		if (sending) return;

		// Mid-stream: a send INJECTS into the running turn instead of starting one.
		if (isStreaming) {
			if (!conversationId) return;
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

		const userMsg = {
			id: newMessageId(),
			role: "user",
			content: text,
			...(readyImages.length
				? {
						images: readyImages.map((p) => ({
							url: p.url,
							mediaType: p.mediaType,
						})),
					}
				: {}),
		};
		const assistantMsg = { id: newMessageId(), role: "assistant", parts: [] };
		setMessages((curr) => [...curr, userMsg, assistantMsg]);
		setInput("");
		setPendingImages((curr) => {
			for (const p of curr) if (p.localUrl) URL.revokeObjectURL(p.localUrl);
			return [];
		});
		setSending(true);
		scrollToBottom();

		let convId = conversationId;
		let created = false;
		if (!convId) {
			try {
				const conv = await createConversation({ agent: effectiveAgent });
				convId = conv.id;
				created = true;
				setModelId(conv.model_id || null);
			} catch {
				setMessages((curr) => {
					const updated = [...curr];
					const last = updated[updated.length - 1];
					updated[updated.length - 1] = {
						...last,
						parts: appendTextPart(
							last.parts,
							"**Error:** failed to start conversation",
						),
					};
					return updated;
				});
				setSending(false);
				return;
			}
		}

		setIsStreaming(true);
		setSending(false);
		// Adopt the new conversation id (page highlights it + refreshes the list).
		if (created) {
			convRef.current = convId;
			onConversationCreated?.(convId);
		}
		scrollToBottom();

		const controller = new AbortController();
		abortRef.current = controller;

		try {
			await streamChat({
				conversationId: convId,
				message: text,
				contextNoteIds: [],
				images: readyImages.map((p) => ({
					url: p.url,
					key: p.key,
					media_type: p.mediaType,
				})),
				signal: controller.signal,
				...buildHandlers(convId, controller.signal),
			});
		} finally {
			setIsStreaming(false);
			setSending(false);
			abortRef.current = null;
			// Sync with server truth: real message ids + branch metadata (so a later
			// edit/regenerate has correct tree pointers). First turn also mints a
			// title server-side — refresh the rail.
			await reloadActivePath(convId);
			if (created) onConversationsChanged?.();
		}
	}, [
		input,
		isStreaming,
		sending,
		conversationId,
		effectiveAgent,
		pendingImages,
		setPendingImages,
		buildHandlers,
		scrollToBottom,
		reloadActivePath,
		onConversationCreated,
		onConversationsChanged,
	]);

	// "Try again" on ANY assistant message: create a NEW reply as a sibling under
	// the same user message (a branch). Everything from this reply onward is
	// replaced by the fresh branch; reload after so the ‹n/n› switcher updates.
	const regenerateAt = useCallback(
		async (msgId) => {
			if (isStreaming || sending) return;
			const convId = conversationId;
			if (!convId) return;
			const idx = messages.findIndex((m) => m.id === msgId);
			if (idx < 0 || messages[idx].role !== "assistant") return;
			const parentId = messages[idx].parentId ?? null;
			if (!parentId) return; // need the user message to reply under
			// Retrieval still wants the prompting user message's text.
			const userText = messages[idx - 1]?.content || "";
			// Truncate to everything before this reply, then a fresh empty bubble.
			const assistantMsg = { id: newMessageId(), role: "assistant", parts: [] };
			setMessages((curr) => [...curr.slice(0, idx), assistantMsg]);
			setIsStreaming(true);
			scrollToBottom();
			const controller = new AbortController();
			abortRef.current = controller;
			try {
				await streamChat({
					conversationId: convId,
					message: userText,
					contextNoteIds: [],
					images: [],
					branch: { regenerate: true, parentId },
					signal: controller.signal,
					...buildHandlers(convId, controller.signal),
				});
			} finally {
				setIsStreaming(false);
				abortRef.current = null;
				await reloadActivePath(convId);
				onConversationsChanged?.();
			}
		},
		[
			isStreaming,
			sending,
			conversationId,
			messages,
			buildHandlers,
			scrollToBottom,
			reloadActivePath,
			onConversationsChanged,
		],
	);

	// Edit an old user message and send → FORK. The new user message is attached
	// as a sibling of the edited one (under its parent); everything from the edit
	// point onward is replaced by the new branch. Reload after to get branch meta.
	const editAndFork = useCallback(
		async (msgId, newText) => {
			const text = (newText || "").trim();
			if (!text || isStreaming || sending) return;
			const convId = conversationId;
			if (!convId) return;
			const idx = messages.findIndex((m) => m.id === msgId);
			if (idx < 0 || messages[idx].role !== "user") return;
			const parentId = messages[idx].parentId ?? null;
			setEditingId(null);
			setEditText("");
			// Optimistic: keep everything before the edit, then the new turn.
			const userMsg = { id: newMessageId(), role: "user", content: text };
			const assistantMsg = { id: newMessageId(), role: "assistant", parts: [] };
			setMessages((curr) => [...curr.slice(0, idx), userMsg, assistantMsg]);
			setIsStreaming(true);
			scrollToBottom();
			const controller = new AbortController();
			abortRef.current = controller;
			try {
				await streamChat({
					conversationId: convId,
					message: text,
					contextNoteIds: [],
					images: [],
					branch: { fork: true, parentId },
					signal: controller.signal,
					...buildHandlers(convId, controller.signal),
				});
			} finally {
				setIsStreaming(false);
				abortRef.current = null;
				await reloadActivePath(convId);
				onConversationsChanged?.();
			}
		},
		[
			isStreaming,
			sending,
			conversationId,
			messages,
			buildHandlers,
			scrollToBottom,
			reloadActivePath,
			onConversationsChanged,
		],
	);

	// Switch which sibling branch is active at a fork; replace the shown path.
	const switchTo = useCallback(
		async (messageId) => {
			const convId = conversationId;
			if (!convId || isStreaming || !messageId) return;
			try {
				const d = await switchBranch(convId, messageId);
				if (convRef.current !== convId) return;
				setMessages((d.messages || []).map(mapServerMessage));
				scrollToBottom();
			} catch {
				pvMessage.error("Couldn't switch branch");
			}
		},
		[conversationId, isStreaming, scrollToBottom],
	);

	// STOP: abort the local stream (instant UI) and tell the backend to cancel.
	const stopStreaming = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		if (convRef.current) stopConversation(convRef.current).catch(() => {});
	}, []);

	const pickModel = useCallback(
		async (m) => {
			setModelMenuOpen(false);
			focusInput();
			setModelId(m.id);
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
		[conversationId, focusInput, setPendingImages],
	);

	// ── Slash commands ─────────────────────────────────────────────────────────
	// Client commands + the active agent's prompt macros, filtered by the typed
	// token (active only while the input is a single `/word`).
	const agentCommands = useMemo(
		() => agents.find((a) => a.kind === effectiveAgent)?.commands || [],
		[agents, effectiveAgent],
	);
	const slashMatches = useMemo(() => {
		if (!input.startsWith("/") || /\s/.test(input)) return [];
		const q = input.slice(1).toLowerCase();
		const client = CLIENT_COMMANDS.map((c) => ({ ...c, kind: "client" }));
		const agent = (Array.isArray(agentCommands) ? agentCommands : []).map(
			(c) => ({ ...c, kind: "agent" }),
		);
		return [...client, ...agent].filter((c) =>
			(c.name || "").toLowerCase().startsWith(q),
		);
	}, [input, agentCommands]);

	// Wipe the current conversation's messages but keep the same conversation id
	// so the thread continues in place. With no active conversation it's a reset.
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

	// Resolve a /title choice: auto-rename via the LLM, or a manual prompt.
	const runTitleAction = useCallback(
		async (key) => {
			setTitleMenu(false);
			focusInput();
			if (!conversationId) return;
			if (key === "auto") {
				try {
					const r = await retitleConversation(conversationId);
					if (r?.title) setTitle(r.title);
					onConversationsChanged?.();
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
					setTitle(t.trim());
					onConversationsChanged?.();
				} catch {
					/* ignore */
				}
			}
		},
		[conversationId, focusInput, onConversationsChanged],
	);

	const runCommand = useCallback(
		(cmd) => {
			if (cmd.kind === "agent") {
				setInput(cmd.prompt || "");
				focusInput();
				return;
			}
			setInput("");
			if (cmd.name === "new") {
				onNewChat?.();
				return focusInput();
			}
			if (cmd.name === "clear") {
				clearMessages();
				return focusInput();
			}
			if (cmd.name === "sessions") {
				onToggleSidebar?.();
				return focusInput();
			}
			if (cmd.name === "models") {
				setModelMenuOpen(true);
				return;
			}
			if (cmd.name === "title") {
				if (!conversationId) return focusInput();
				setTitleActive(0);
				setTitleMenu(true);
			}
		},
		[conversationId, clearMessages, focusInput, onNewChat, onToggleSidebar],
	);

	const onKeyDown = (e) => {
		// /title submenu: arrows move the highlight, Enter picks, Escape dismisses.
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
		// Slash menu: arrows move the highlight, Enter/Tab run it, Escape dismisses.
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

	const hasText = input.trim().length > 0;
	const hasReadyImage = pendingImages.some((p) => p.status === "ready");
	const showStop = isStreaming && !hasText;
	const canSend = (hasText || hasReadyImage) && !uploadingImages;

	return (
		<section className="chatx-conv">
			<header className="chatx-conv-head">
				<button
					type="button"
					className="chatx-hamburger"
					onClick={onToggleSidebar}
					aria-label="Toggle conversations"
					title="Conversations"
				>
					☰
				</button>
				<div className="chatx-conv-titlewrap">
					<span className="chatx-conv-title">
						{title || (conversationId ? "Untitled" : "New chat")}
					</span>
					{meta?.created_at ? (
						<span className="chatx-conv-meta">
							{(() => {
								const c = formatDateTime(meta.created_at);
								return `created ${c.date} ${c.time}`;
							})()}
							{meta.updated_at && meta.updated_at !== meta.created_at
								? ` · edited ${timeAgo(meta.updated_at)}`
								: ""}
						</span>
					) : null}
				</div>
				<div className={`chatx-status${isStreaming ? " streaming" : ""}`}>
					<span className="chatx-status-dot" />
				</div>
				<div className="chatx-model">
					<button
						type="button"
						className="chatx-model-btn"
						onClick={() => setModelMenuOpen((o) => !o)}
						title="Model for this chat"
					>
						<span className="chatx-model-name">
							{activeModel?.display_name || "default model"}
						</span>
						<DownOutlined className="chatx-model-caret" />
					</button>
					{modelMenuOpen ? (
						<>
							<button
								type="button"
								className="chatx-model-backdrop"
								aria-label="Close model menu"
								onClick={() => setModelMenuOpen(false)}
							/>
							<div className="chatx-model-menu">
								{allModels.length === 0 ? (
									<div className="picker-empty">None</div>
								) : (
									allModels.map((m) => {
										const inUse = modelId ? m.id === modelId : m.is_default;
										return (
											<button
												key={m.id}
												type="button"
												className={`picker-item${inUse ? " is-current" : ""}`}
												onClick={() => pickModel(m)}
											>
												{/* Left mark: the in-use model shows the accent (selected)
												    diamond; otherwise the default model shows a white one.
												    When the default IS selected, the selected diamond
												    takes the slot. */}
												<span
													className={`picker-item-mark${!inUse && m.is_default ? " chatx-mark-default" : ""}`}
													title={
														inUse
															? "Selected model"
															: m.is_default
																? "Default model"
																: undefined
													}
													aria-hidden="true"
												>
													{inUse || m.is_default ? "◆" : ""}
												</span>
												{m.display_name}{" "}
												<span className="picker-item-meta">{m.provider}</span>
												<span className="model-caps" aria-hidden="true">
													{m.supports_thinking ? (
														<BulbOutlined title="Reasoning" />
													) : null}
													{m.supports_vision ? (
														<EyeOutlined title="Vision" />
													) : null}
													{m.supports_tools ? (
														<ToolOutlined title="Tools" />
													) : null}
												</span>
											</button>
										);
									})
								)}
							</div>
						</>
					) : null}
				</div>
			</header>

			<MessageList
				messages={messages}
				isStreaming={isStreaming}
				sending={sending}
				agentLabel={agentLabel}
				loadingConv={loadingConv}
				editingId={editingId}
				editText={editText}
				setEditingId={setEditingId}
				setEditText={setEditText}
				onNavigate={goTo}
				onSwitchTo={switchTo}
				onEditAndFork={editAndFork}
				onRegenerate={regenerateAt}
				modelLabelFor={modelLabelFor}
				scrollRef={scrollRef}
				onScroll={handleScroll}
				showJump={showJump}
				onJump={scrollToBottom}
			/>

			<div className="chat-composer">
				<div className="chat-composer-inner">
					<PendingImages images={pendingImages} onRemove={removePendingImage} />
					<div className="chat-composer-fields">
						<SlashMenu
							items={slashItems(slashMatches)}
							active={slashActive}
							onPick={(_it, i) => runCommand(slashMatches[i])}
							onHover={setSlashActive}
						/>
						{titleMenu ? (
							<SlashMenu
								items={titleItems}
								active={titleActive}
								onPick={(it) => runTitleAction(it.key)}
								onHover={setTitleActive}
							/>
						) : null}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for image attachments */}
						<div
							className="chat-composer-row"
							onDrop={onDrop}
							onDragOver={(e) => {
								if (visionEnabled) e.preventDefault();
							}}
						>
							<button
								type="button"
								className="chatx-attach"
								onClick={() => fileRef.current?.click()}
								disabled={!visionEnabled}
								title={
									visionEnabled
										? "Attach an image"
										: "This model can't read images"
								}
							>
								＋
							</button>
							<input
								ref={fileRef}
								type="file"
								accept="image/*"
								multiple
								hidden
								onChange={(e) => {
									for (const f of e.target.files || []) addImageFile(f);
									e.target.value = "";
								}}
							/>
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
								placeholder={`Ask ${agentLabel} anything…`}
								rows={1}
							/>
							{sending ? (
								<button
									type="button"
									className="chat-send"
									disabled
									title="Sending…"
								>
									<span className="chat-send-spinner" /> send
								</button>
							) : showStop ? (
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
		</section>
	);
}
