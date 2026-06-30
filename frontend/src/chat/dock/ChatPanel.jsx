import {
	BulbOutlined,
	DeleteOutlined,
	ExpandAltOutlined,
	EyeOutlined,
	FormOutlined,
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
	switchBranch,
	updateConversation,
} from "../../api/agentChatApi";
import { useAgentList, useDefaultAgent } from "../../queries";
import useNotesWorkspaceStore from "../../store/notesWorkspaceStore";
import ContextTag from "../components/ContextTag";
import MessageList from "../components/MessageList";
import PendingImages from "../components/PendingImages";
import SlashMenu from "../components/SlashMenu";
import SpriteRunner from "../components/SpriteRunner";
import {
	appendTextPart,
	mapServerMessage,
	newMessageId,
} from "../engine/messageModel";
import useChatScroll from "../engine/useChatScroll";
import useChatStream from "../engine/useChatStream";
import useImageUpload from "../engine/useImageUpload";
import useModelCatalog from "../engine/useModelCatalog";
import "../chat-shared.css";

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

// Replaces the trailing reply when dropped-stream recovery gives up.
const RECOVER_TIMEOUT_TEXT =
	"_The reply is taking a while. Reopen this chat to see it once it finishes._";

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
			// start with /settings or /tasks, so they're excluded.)
			let path = to;
			const uuid = path.match(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
			);
			if (uuid && !/^\/(notes|tasks|storage|settings)\b/.test(path)) {
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
	// True from clicking send until the stream starts — covers the
	// create-conversation + first-request gap so the send button shows a loader.
	const [sending, setSending] = useState(false);
	const [compact, setCompact] = useState(false);
	const [confirmClearOpen, setConfirmClearOpen] = useState(false);
	const [overlay, setOverlay] = useState(null); // null | "models" | "sessions"
	const [pickList, setPickList] = useState([]);
	const [slashActive, setSlashActive] = useState(0); // highlighted slash item
	const [overlayActive, setOverlayActive] = useState(0); // highlighted picker row
	const [sessionQuery, setSessionQuery] = useState(""); // sessions search box
	const [titleMenu, setTitleMenu] = useState(false); // /title two-option menu
	const [titleActive, setTitleActive] = useState(0); // highlighted title option
	const [conversationId, setConversationId] = useState(null);
	// The model bound to the active conversation (db_chat_conversations.model_id),
	// or null when it hasn't been overridden — then the backend uses the default.
	const [modelId, setModelId] = useState(null);
	// On mount we open the most recently edited conversation (see the effect
	// below). Until that resolves the panel is unhydrated; once it (or any
	// conversation created later this session) lands, hydrated stays true so the
	// open effect never clobbers live streaming state.
	const [hydrated, setHydrated] = useState(false);
	// True while a conversation's history is being fetched (the initial open or a
	// /sessions switch) — drives the pixel-Piuma loader so the panel doesn't read
	// as "empty" mid-load and then pop. Seeded true for the initial open.
	const [loadingConv, setLoadingConv] = useState(true);
	// The currently-shown conversation, as a ref — so async writers (a detached
	// stream, the recover poller) can bail if the user has switched away, instead
	// of clobbering the conversation now on screen.
	const convRef = useRef(conversationId);
	useEffect(() => {
		convRef.current = conversationId;
	}, [conversationId]);
	const abortRef = useRef(null);
	const inputRef = useRef(null);
	// Return focus to the composer after any picker/menu operation, so the whole
	// flow stays keyboard-driven (no click needed to type again). rAF waits for
	// the picker's unmount to commit before we grab focus back.
	const focusInput = useCallback(() => {
		requestAnimationFrame(() => inputRef.current?.focus());
	}, []);
	// Open (or close) the slash-command picker via the composer button. The menu
	// keys off the input starting with "/", so we just seed/clear that token.
	const toggleSlashMenu = useCallback(() => {
		setInput((cur) => (cur === "/" ? "" : "/"));
		setSlashActive(0);
		setTitleMenu(false);
		focusInput();
	}, [focusInput]);
	const slashActiveRef = useRef(null);
	const overlayActiveRef = useRef(null);

	// Editing an old user message (fork-on-send).
	const [editingId, setEditingId] = useState(null);
	const [editText, setEditText] = useState("");

	// Shared engine pieces.
	const { scrollRef, handleScroll, scrollToBottom, showJump } =
		useChatScroll(messages);
	const { visionEnabled, activeModelRef, modelLabelFor } =
		useModelCatalog(modelId);
	const {
		pendingImages,
		setPendingImages,
		uploadingImages,
		removePendingImage,
		onPaste,
		onDrop,
	} = useImageUpload({ visionEnabled, convRef });
	const { buildHandlers, reloadActivePath } = useChatStream({
		convRef,
		setMessages,
		setIsStreaming,
		activeModelRef,
		recoverTimeoutText: RECOVER_TIMEOUT_TEXT,
	});

	// On mount, open the most recently edited conversation. The list is ordered
	// by updated_at DESC server-side, so the first row is the latest; a fresh
	// vault with no conversations stays blank. Runs once — afterwards streaming
	// owns local state.
	useEffect(() => {
		if (hydrated) return;
		let cancelled = false;
		(async () => {
			try {
				const list = await fetchConversations(undefined, undefined, {
					limit: 1,
				});
				const latest = Array.isArray(list) ? list[0] : null;
				if (latest) {
					const d = await fetchConversation(latest.id);
					if (cancelled) return;
					setConversationId(latest.id);
					setModelId(d.conversation?.model_id || null);
					setMessages((d.messages || []).map(mapServerMessage));
				}
			} catch {
				/* leave the panel blank */
			} finally {
				if (!cancelled) {
					setHydrated(true);
					setLoadingConv(false);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [hydrated]);

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

	useEffect(() => () => abortRef.current?.abort(), []);

	const confirmClear = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setLoadingConv(false);
		setMessages([]);
		setConversationId(null);
		setModelId(null);
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

	const sendMessage = useCallback(async () => {
		const text = input.trim();
		const readyImages = pendingImages.filter(
			(p) => p.status === "ready" && p.url,
		);
		if (!text && !readyImages.length) return;
		// Ignore clicks during the brief setup gap (button already shows a loader).
		if (sending) return;
		// Block send while an upload is in flight (covers the Enter-key path too,
		// which bypasses the button's disabled state) so we never drop a
		// half-uploaded image that has no CDN url yet.
		if (pendingImages.some((p) => p.status === "uploading")) return;

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
		// Show the message + an empty assistant bubble IMMEDIATELY, and put the
		// send button into a loading state — instant feedback during the
		// create-conversation + first-request gap (don't wait on the network).
		setMessages((curr) => [...curr, userMsg, assistantMsg]);
		setInput("");
		// Sent → drop the pending chips (the CDN urls now live on the message).
		setPendingImages((curr) => {
			for (const p of curr) if (p.localUrl) URL.revokeObjectURL(p.localUrl);
			return [];
		});
		setSending(true);
		scrollToBottom();

		let convId = conversationId;
		if (!convId) {
			try {
				// Pin the model the user picked for this (still conversation-less)
				// chat. Without this the new conversation is created with the global
				// default and the first turn ignores the selection.
				const conv = await createConversation({
					agent: effectiveAgent,
					...(modelId ? { model_id: modelId } : {}),
				});
				convId = conv.id;
				setConversationId(conv.id);
				// Reflect what the server actually pinned, but don't drop a selection
				// we just sent (the response echoes it back anyway).
				setModelId(conv.model_id || modelId || null);
			} catch {
				// Surface the failure in the assistant bubble we already showed.
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
		scrollToBottom(); // sending re-arms the stick-to-bottom lock

		const controller = new AbortController();
		abortRef.current = controller;

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
				...buildHandlers(convId, controller.signal),
			});
		} finally {
			// Always re-enable the composer, even if the stream throws.
			setIsStreaming(false);
			setSending(false);
			abortRef.current = null;
			// Sync to server truth: real ids + branch metadata for later edits.
			await reloadActivePath(convId);
		}
	}, [
		input,
		isStreaming,
		sending,
		conversationId,
		modelId,
		effectiveAgent,
		sentContextPaths,
		sentContextIds,
		pendingImages,
		setPendingImages,
		buildHandlers,
		reloadActivePath,
		scrollToBottom,
	]);

	// Regenerate ANY assistant reply as a sibling branch (under the same user
	// message); reload after so the ‹n/n› switcher reflects the new sibling.
	const regenerateAt = useCallback(
		async (msgId) => {
			if (isStreaming || sending) return;
			const convId = conversationId;
			if (!convId) return;
			const idx = messages.findIndex((m) => m.id === msgId);
			if (idx < 0 || messages[idx].role !== "assistant") return;
			const parentId = messages[idx].parentId ?? null;
			if (!parentId) return;
			const userText = messages[idx - 1]?.content || "";
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
			}
		},
		[
			isStreaming,
			sending,
			conversationId,
			messages,
			buildHandlers,
			reloadActivePath,
			scrollToBottom,
		],
	);

	// Edit an old user message and send → FORK (new sibling under its parent).
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
			}
		},
		[
			isStreaming,
			sending,
			conversationId,
			messages,
			buildHandlers,
			reloadActivePath,
			scrollToBottom,
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
	// Same idea for the /models picker: open the overlay immediately and show the
	// loader while fetchAllModels() is in flight, instead of waiting for the
	// request before opening (which left the user with no feedback).
	const [modelsLoading, setModelsLoading] = useState(false);

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
		try {
			const d = await fetchConversation(id);
			setModelId(d.conversation?.model_id || null);
			setMessages((d.messages || []).map(mapServerMessage));
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
				// Open the picker right away with a loader, then fill it — so there's
				// immediate feedback while the model list is fetched.
				setPickList([]);
				setOverlayActive(0);
				setModelsLoading(true);
				setOverlay("models");
				try {
					setPickList(await fetchAllModels());
				} catch {
					/* ignore — empty list renders the "None" state */
				} finally {
					setModelsLoading(false);
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
		[conversationId, focusInput, setPendingImages],
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
				<button
					type="button"
					className="chat-clear"
					onClick={() => navigate("/chat")}
					aria-label="Open full-screen chat"
					title="Open full-screen chat"
				>
					<ExpandAltOutlined />
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
					<PendingImages images={pendingImages} onRemove={removePendingImage} />
					<div className="chat-composer-fields">
						<SlashMenu
							items={slashItems(slashMatches)}
							active={slashActive}
							onPick={(_it, i) => runCommand(slashMatches[i])}
							onHover={setSlashActive}
							activeRef={slashActiveRef}
						/>
						{titleMenu ? (
							<SlashMenu
								items={titleItems}
								active={titleActive}
								onPick={(it) => runTitleAction(it.key)}
								onHover={setTitleActive}
							/>
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
									{(overlay === "sessions" && sessionsLoading) ||
									(overlay === "models" && modelsLoading) ? (
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
							<button
								type="button"
								className="chat-slash-btn"
								onClick={toggleSlashMenu}
								title="Commands"
								aria-label="Open command menu"
							>
								/
							</button>
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
