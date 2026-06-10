import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Alert,
	Keyboard,
	Linking,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import {
	SafeAreaView,
	useSafeAreaInsets,
} from "react-native-safe-area-context";
import {
	clearConversation,
	createConversation,
	deleteConversation,
	fetchAgents,
	fetchAllModels,
	fetchConversation,
	fetchConversations,
	fetchDefaultAgent,
	injectMessage,
	retitleConversation,
	stopConversation,
	streamChat,
	updateConversation,
} from "../api/agentChatApi";
import MarkdownView from "../components/MarkdownView";
import PiumaRunning from "../components/PiumaRunning";
import { toast } from "../components/Toast";
import PiumaAvatar from "../components/PiumaAvatar";
import StreamingCursor from "../components/StreamingCursor";
import { TOP_EXTRA } from "../components/SystemBars";
import ThinkingLoader from "../components/ThinkingLoader";
import { colors } from "../utils/theme";
import useProgressiveText from "../utils/useProgressiveText";

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "monospace",
});

const ASSISTANT_LABEL = "assistant stream";
const AGENT_LABEL = "assistant";
const SUBMIT_LABEL = "send";
const STOP_LABEL = "stop";

// Restores the active agents conversation across mounts.
const CONV_STORAGE_KEY = "agents_active_conv";

// Universal slash commands (same for every agent). Per-agent macros are merged
// in from the agent's `commands`. Mirrors the web ChatPanel.
const CLIENT_COMMANDS = [
	{ name: "new", description: "Start a new conversation" },
	{ name: "clear", description: "Wipe this conversation's messages" },
	{ name: "sessions", description: "Switch to another conversation" },
	{ name: "models", description: "Pick the model for this chat" },
	{ name: "title", description: "Rename this conversation" },
];

// Composer auto-grow bounds: one line on start, expand up to ~5 lines, then
// the input scrolls internally. Mirrors the frontend composer behaviour.
const INPUT_MIN_H = 44;
const INPUT_MAX_H = 124;

const newMessageId = () =>
	`msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Normalised content blocks → plain text (for rendering reloaded turns).
const blocksToText = (content) => {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
	return "";
};

// "/folder/sub/My Note" → "My Note" for the chip label.
const noteTitleFromPath = (path) => {
	if (!path) return "";
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] || path;
};

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

// Fold a `tool`-stream event into the assistant message's ordered parts, keyed by
// the tool-call id: a start frame opens (or extends) the trailing tool-run; a
// completion frame flips that chip to done/error. Tools land inline in stream
// order rather than all grouped together.
const applyToolEventToParts = (parts = [], evt) => {
	const id = evt.id || evt.name;
	const next = [...parts];
	if (evt.done) {
		for (let i = next.length - 1; i >= 0; i--) {
			if (next[i].kind !== "tools") continue;
			const idx = next[i].tools.findIndex((t) => t.id === id);
			if (idx >= 0) {
				const tools = [...next[i].tools];
				tools[idx] = {
					...tools[idx],
					label: evt.label || tools[idx].label,
					status: evt.ok ? "done" : "error",
				};
				next[i] = { ...next[i], tools };
				break;
			}
		}
		return next;
	}
	const entry = {
		id,
		name: evt.name || "tool",
		args: summarizeToolArgs(evt.args),
		status: "running",
	};
	let run = next[next.length - 1];
	if (run?.kind !== "tools") {
		run = { kind: "tools", id: `p${next.length}`, tools: [] };
		next.push(run);
	} else {
		run = { ...run, tools: [...run.tools] };
		next[next.length - 1] = run;
	}
	const existing = run.tools.findIndex((t) => t.id === id);
	if (existing >= 0) run.tools[existing] = { ...run.tools[existing], ...entry };
	else run.tools.push(entry);
	return next;
};

// Walk persisted content blocks IN ORDER into renderable parts, so tools + mid-turn
// injections show up inline where they happened rather than all grouped. A part is
// a `text` segment, a `tools` run (consecutive chips), or an `inject` (a user
// message dropped into the turn). `tool_result` sets the matching chip's status;
// `thinking` blocks are skipped.
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
				args: summarizeToolArgs(b.input),
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
				// Show the entity's name (note/task title) on the chip, not the UUID.
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

// Append text to a parts array, extending the trailing text segment or adding one.
const appendTextPart = (parts, text) => {
	const next = [...(parts || [])];
	const t = next[next.length - 1];
	if (t?.kind === "text") next[next.length - 1] = { ...t, text: t.text + text };
	else next.push({ kind: "text", id: `p${next.length}`, text });
	return next;
};

// Map a `navigate`-tool intent to an in-app path (mirrors the web scheme). The
// path is then resolved to a screen by `goTo` in the screen component.
const navTargetToPath = ({ target, id, route, url } = {}) => {
	switch (target) {
		case "note":
			return id ? `/notes/${id}` : null;
		case "event":
			return id ? `/admin/calendar?event=${id}` : null;
		case "task":
			return id ? `/tasks?task=${id}` : null;
		case "view": {
			const r = (route || "").toLowerCase();
			if (r.includes("calendar")) return "/admin/calendar";
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

// Pull a query param value out of an in-app path like "/tasks?task=<id>".
const paramFrom = (path, key) => {
	const q = path.indexOf("?");
	if (q < 0) return null;
	const params = new URLSearchParams(path.slice(q + 1));
	return params.get(key);
};

const TOOL_GLYPH = { running: "⛏", done: "✓", error: "✕" };

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

// MarkdownView's body styles are sans-serif by default (to match the note
// editor look). The chat is a terminal — force monospace everywhere.
const chatMarkdownTextStyle = { fontFamily: MONO };

function UserBubble({ content, context }) {
	return (
		<View style={styles.userRow}>
			<View style={styles.userCol}>
				<View style={styles.userCard}>
					<Text style={styles.userText}>{content}</Text>
				</View>
				{context?.length ? (
					<View style={styles.bubbleContextRow}>
						{context.map((p) => (
							<View key={p} style={styles.bubbleContextTag}>
								<Text style={styles.bubbleContextIcon}>◆</Text>
								<Text style={styles.bubbleContextLabel} numberOfLines={1}>
									{noteTitleFromPath(p)}
								</Text>
							</View>
						))}
					</View>
				) : null}
			</View>
		</View>
	);
}

// Persistent list of tools the agent ran/is running for one assistant turn.
// Chips size to content and wrap; we count the wrapped ROWS (distinct chip
// y-offsets) and only collapse a longer settled run (3+ rows) into a summary.
function ToolActivity({ tools, isStreaming }) {
	const [expanded, setExpanded] = useState(false);
	const [rowCount, setRowCount] = useState(1);
	const chipY = useRef(new Map());
	if (!tools?.length) return null;
	const anyErr = tools.some((t) => t.status === "error");

	// Each chip reports its top offset; distinct offsets = number of wrapped rows.
	const onChipLayout = (id) => (e) => {
		chipY.current.set(id, Math.round(e.nativeEvent.layout.y));
		const n = new Set(chipY.current.values()).size;
		setRowCount((p) => (p === n ? p : n));
	};

	const list = (
		<View style={styles.tools}>
			{tools.map((t) => (
				<View
					key={t.id}
					onLayout={onChipLayout(t.id)}
					style={[styles.tool, styles[`tool_${t.status}`]]}
				>
					<Text style={[styles.toolIcon, styles[`toolIcon_${t.status}`]]}>
						{TOOL_GLYPH[t.status] || "⛏"}
					</Text>
					<Text style={styles.toolName}>{t.name}</Text>
					{t.label || t.args ? (
						<Text style={styles.toolArgs} numberOfLines={1}>
							{t.label || t.args}
						</Text>
					) : null}
				</View>
			))}
		</View>
	);

	// Show the full activity while streaming, and while it fits in fewer than 3
	// wrapped rows. Only collapse a longer settled run (3+ rows) into a one-line,
	// tap-to-expand summary.
	if (isStreaming || rowCount < 3) return list;
	return (
		<View style={styles.toolsWrap}>
			<Pressable
				onPress={() => setExpanded((v) => !v)}
				style={[styles.toolsSummary, anyErr && styles.toolsSummaryErr]}
				hitSlop={6}
			>
				<Text style={styles.toolsSummaryCaret}>{expanded ? "▾" : "▸"}</Text>
				<Text style={styles.toolsSummaryText} numberOfLines={1}>
					🔧 {tools.length} tool{tools.length === 1 ? "" : "s"} ·{" "}
					{toolSummary(tools)}
				</Text>
				<Text
					style={[
						styles.toolIcon,
						anyErr ? styles.toolIcon_error : styles.toolIcon_done,
					]}
				>
					{anyErr ? "✕" : "✓"}
				</Text>
			</Pressable>
			{expanded ? list : null}
		</View>
	);
}

// One text segment of an assistant turn, progressively revealed (drips toward the
// streamed target; instant for reloaded turns since it mounts already-full).
function AssistantTextPart({ text, onLinkPress }) {
	const { text: visible } = useProgressiveText(text || "");
	return (
		<MarkdownView
			source={visible}
			textStyle={chatMarkdownTextStyle}
			onLinkPress={onLinkPress}
		/>
	);
}

function AssistantBubble({ parts, isStreaming, onNavigate }) {
	const isEmpty = !parts?.length;

	// Avatar only appears while the dog is "thinking" — the ThinkingLoader
	// owns its own avatar tile, so we don't draw a second one alongside it.
	if (isEmpty && isStreaming) {
		return (
			<View style={styles.assistantBody}>
				<Text style={styles.assistantRoleLabel}>{ASSISTANT_LABEL}</Text>
				<ThinkingLoader label={`${AGENT_LABEL} is sniffing the trail`} />
			</View>
		);
	}

	return (
		<View style={styles.assistantBody}>
			<Text style={styles.assistantRoleLabel}>{ASSISTANT_LABEL}</Text>
			{/* Text, tool runs, and mid-turn injections — in stream order. */}
			{(parts || []).map((p) => {
				if (p.kind === "tools")
					return (
						<ToolActivity
							key={p.id}
							tools={p.tools}
							isStreaming={isStreaming}
						/>
					);
				if (p.kind === "inject")
					return (
						<View key={p.id} style={styles.inject}>
							<Text style={styles.injectLabel}>you ↩</Text>
							<Text style={styles.injectText}>{p.text}</Text>
						</View>
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
						<Pressable
							key={p.id}
							style={styles.navAction}
							onPress={() => onNavigate?.(to)}
							hitSlop={6}
						>
							<Text style={styles.navActionIcon}>↗</Text>
							<Text style={styles.navActionLabel}>Go → {navLabel}</Text>
						</Pressable>
					);
				}
				return (
					<AssistantTextPart
						key={p.id}
						text={p.text}
						onLinkPress={onNavigate}
					/>
				);
			})}
			{isStreaming ? <StreamingCursor /> : null}
		</View>
	);
}

export default function ChatScreen({ onClose, notePath, noteId }) {
	const insets = useSafeAreaInsets();
	const navigation = useNavigation();

	// Single navigation entry point for chat links and "Go" actions. Maps in-app
	// paths (mirroring the web scheme) to native screens; external http(s) open in
	// the browser. Returns true when it handled the target (so MarkdownView skips
	// its Linking fallback).
	const goTo = useCallback(
		(to) => {
			if (!to) return false;
			if (/^https?:\/\//i.test(to)) {
				Linking.openURL(to).catch(() => {});
				return true;
			}
			if (!to.startsWith("/")) return false;
			if (to.startsWith("/notes")) {
				const id = to.match(/^\/notes\/([^/?#]+)/)?.[1];
				navigation.navigate("VaultHome", id ? { noteId: id } : {});
				return true;
			}
			if (to.startsWith("/tasks")) {
				const id = paramFrom(to, "task");
				navigation.navigate("Tasks", id ? { taskId: id } : {});
				return true;
			}
			if (to.startsWith("/admin/calendar")) {
				const id = paramFrom(to, "event");
				navigation.navigate("Calendar", id ? { eventId: id } : {});
				return true;
			}
			if (to.startsWith("/storage")) {
				navigation.navigate("Storage");
				return true;
			}
			return false;
		},
		[navigation],
	);
	const [messages, setMessages] = useState([]);
	const [input, setInput] = useState("");
	const [inputHeight, setInputHeight] = useState(INPUT_MIN_H);
	// Composer height — measured so the floating picker (slash list / sessions /
	// models / rename) anchors just above the input, like the web chat.
	const [composerH, setComposerH] = useState(0);
	const [isStreaming, setIsStreaming] = useState(false);
	const [keyboardVisible, setKeyboardVisible] = useState(false);
	// Active agents conversation + the agent for new chats (admin default).
	const [conversationId, setConversationId] = useState(null);
	// The conversation's chosen model (null = use the admin default). Drives the
	// "in use" marker in the /models picker.
	const [modelId, setModelId] = useState(null);
	const [agentKind, setAgentKind] = useState("vault_agent");
	const [agentLabel, setAgentLabel] = useState("Piuma");
	const [agentCommands, setAgentCommands] = useState([]);
	// Slash-command overlay: null | "models" | "sessions" | "title".
	const [overlay, setOverlay] = useState(null);
	const [pickList, setPickList] = useState([]);
	const [titleDraft, setTitleDraft] = useState("");
	const [sessionQuery, setSessionQuery] = useState(""); // sessions search box
	// The open note is attached as context by default; tapping the chip toggles
	// it off for the next send. Mobile keeps it to a single note (no tabs, no
	// lock state) — the chip just mirrors whatever note opened this chat.
	const [contextAttached, setContextAttached] = useState(true);
	// True while a conversation's history is being fetched (restore on mount or a
	// /sessions switch) — drives the pixel-Piuma loader so the panel doesn't read
	// as "empty/ready" mid-load and then pop. Seeded true; the restore effect
	// flips it off immediately on a fresh open (no stored conversation).
	const [loadingConv, setLoadingConv] = useState(true);
	// Mirror of the shown conversation so async writers (a detached stream, the
	// recover poller) can bail if the user switched away rather than clobber the
	// conversation now on screen.
	const conversationIdRef = useRef(conversationId);
	useEffect(() => {
		conversationIdRef.current = conversationId;
	}, [conversationId]);
	const scrollRef = useRef(null);
	const abortRef = useRef(null);
	// Stick-to-bottom: only auto-follow new content while the user is already
	// parked near the bottom. Scrolling up releases the lock (so streaming tokens
	// stop yanking the view down) and reveals a "jump to latest" button.
	const atBottomRef = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const handleScroll = useCallback((e) => {
		const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
		const distanceFromBottom =
			contentSize.height - (contentOffset.y + layoutMeasurement.height);
		const atBottom = distanceFromBottom < 80;
		atBottomRef.current = atBottom;
		setShowJump((prev) => (prev === !atBottom ? prev : !atBottom));
	}, []);

	const scrollToBottom = useCallback((animated = true) => {
		atBottomRef.current = true;
		setShowJump(false);
		scrollRef.current?.scrollToEnd({ animated });
	}, []);

	useEffect(() => () => abortRef.current?.abort(), []);

	useEffect(() => {
		const showSub = Keyboard.addListener("keyboardDidShow", () =>
			setKeyboardVisible(true),
		);
		const hideSub = Keyboard.addListener("keyboardDidHide", () =>
			setKeyboardVisible(false),
		);
		return () => {
			showSub.remove();
			hideSub.remove();
		};
	}, []);

	// Re-attach context whenever a different note opens this chat, so the chip
	// always defaults to the freshly-opened note.
	useEffect(() => {
		if (notePath) setContextAttached(true);
	}, [notePath]);

	// On mount: pick up the admin default agent for new chats, and restore the
	// last conversation (id in AsyncStorage) from the agents API, seeding local
	// state. After this, streaming owns local state.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			// Decide up front whether we're restoring a conversation, so the loader
			// shows immediately for a restore and never flashes on a fresh open.
			let stored = null;
			try {
				stored = await AsyncStorage.getItem(CONV_STORAGE_KEY);
			} catch {
				/* treat as no stored conversation */
			}
			if (cancelled) return;
			setLoadingConv(!!stored);

			// Pick up the admin default agent for new chats, and resolve its
			// display name for the header.
			let kind = "vault_agent";
			try {
				const def = await fetchDefaultAgent();
				if (def?.agent) kind = def.agent;
			} catch {
				/* fall back to vault_agent */
			}
			if (!cancelled) setAgentKind(kind);
			try {
				const agents = await fetchAgents();
				const a = agents.find((x) => x.kind === kind);
				if (!cancelled && a?.display_name) setAgentLabel(a.display_name);
				if (!cancelled && Array.isArray(a?.commands))
					setAgentCommands(a.commands);
			} catch {
				/* keep the default label */
			}
			if (!stored) return;
			try {
				const data = await fetchConversation(stored);
				if (cancelled) return;
				setConversationId(stored);
				setModelId(data.conversation?.model_id ?? null);
				setMessages(
					(data.messages || []).map((m) => ({
						id: m.id,
						role: m.role,
						content: blocksToText(m.content),
						...(m.role === "assistant"
							? { parts: blocksToParts(m.content) }
							: {}),
					})),
				);
			} catch {
				await AsyncStorage.removeItem(CONV_STORAGE_KEY);
			} finally {
				if (!cancelled) setLoadingConv(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Wipe local state to start a fresh conversation; the old one stays saved
	// server-side. No confirmation (the slash commands call this directly).
	const startNewChat = useCallback(async () => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setLoadingConv(false);
		setOverlay(null);
		setMessages([]);
		setConversationId(null);
		setModelId(null);
		setInput("");
		try {
			await AsyncStorage.removeItem(CONV_STORAGE_KEY);
		} catch {
			/* best-effort */
		}
	}, []);

	// Wipe the current conversation's messages but keep the same conversation
	// (and its id) so the thread continues in place. With no active conversation
	// this is just a local reset.
	const clearMessages = useCallback(async () => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setOverlay(null);
		setMessages([]);
		setInput("");
		if (!conversationId) return;
		try {
			await clearConversation(conversationId);
		} catch {
			/* ignore */
		}
	}, [conversationId]);

	const handleClearConversation = useCallback(() => {
		const message =
			"This starts a fresh chat. The current conversation stays saved but won't be shown here anymore.";
		if (Platform.OS === "web") {
			// RN Alert on web is a no-op — fall back to window.confirm.
			if (
				typeof window !== "undefined" &&
				window.confirm(`Start a new conversation? ${message}`)
			) {
				startNewChat();
			}
			return;
		}
		Alert.alert("Start a new conversation?", message, [
			{ text: "Cancel", style: "cancel" },
			{ text: "New chat", style: "destructive", onPress: startNewChat },
		]);
	}, [startNewChat]);

	// Open a stored conversation (from the /sessions picker).
	const switchConversation = useCallback(async (id) => {
		setOverlay(null);
		// Detach any active stream WITHOUT cancelling the backend turn — it keeps
		// running and is persisted, so it's intact when you switch back. Aborting
		// the fetch stops its callbacks writing into this new conversation.
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		setConversationId(id);
		setMessages([]);
		setLoadingConv(true);
		try {
			await AsyncStorage.setItem(CONV_STORAGE_KEY, id);
			const d = await fetchConversation(id);
			setModelId(d.conversation?.model_id ?? null);
			setMessages(
				(d.messages || []).map((m) => ({
					id: m.id,
					role: m.role,
					content: blocksToText(m.content),
					...(m.role === "assistant"
						? { parts: blocksToParts(m.content) }
						: {}),
				})),
			);
		} catch {
			/* ignore */
		} finally {
			setLoadingConv(false);
		}
	}, []);

	const pickModel = useCallback(
		async (m) => {
			setOverlay(null);
			setModelId(m.id); // optimistic; also carried into a not-yet-created convo
			toast.success(`Model switched to ${m.display_name}`);
			if (conversationId) {
				try {
					await updateConversation({ id: conversationId, model_id: m.id });
				} catch {
					toast.error("Couldn't save the model change");
				}
			}
		},
		[conversationId],
	);

	const saveTitle = useCallback(async () => {
		const t = titleDraft.trim();
		setOverlay(null);
		if (t && conversationId) {
			try {
				await updateConversation({ id: conversationId, title: t });
			} catch {
				/* ignore */
			}
		}
	}, [titleDraft, conversationId]);

	// /title → auto: regenerate the title with the LLM.
	const autoRename = useCallback(async () => {
		setOverlay(null);
		if (!conversationId) return;
		try {
			await retitleConversation(conversationId);
		} catch {
			/* ignore */
		}
	}, [conversationId]);

	// Delete a conversation straight from the /sessions list. Optimistically
	// drops it; if it's the open one, reset to a fresh chat.
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

	// Load the sessions list (debounced) whenever the picker is open and the
	// query changes. `q` matches conversation title or message text.
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
					setSessionsLoading(false);
				};
				// Hold the loader for a ~1s floor (set on open) so it doesn't flash.
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

	// Slash menu: client commands + the active agent's macros, filtered by the
	// typed token (active only while the input is a single `/word`).
	const slashMatches =
		input.startsWith("/") && !/\s/.test(input)
			? (() => {
					const q = input.slice(1).toLowerCase();
					const client = CLIENT_COMMANDS.map((c) => ({ ...c, kind: "client" }));
					const agent = (Array.isArray(agentCommands) ? agentCommands : []).map(
						(c) => ({ ...c, kind: "agent" }),
					);
					return [...client, ...agent].filter((c) =>
						(c.name || "").toLowerCase().startsWith(q),
					);
				})()
			: [];

	const runCommand = useCallback(
		async (cmd) => {
			if (cmd.kind === "agent") {
				setInput(cmd.prompt || "");
				return;
			}
			setInput("");
			if (cmd.name === "new") return startNewChat();
			if (cmd.name === "clear") return clearMessages();
			if (cmd.name === "title") {
				if (!conversationId) return;
				setTitleDraft("");
				setOverlay("title");
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
				// The list is loaded (and re-loaded on search) by the debounced
				// effect, keyed on the open overlay + query.
				setPickList([]);
				setSessionQuery("");
				setOverlay("sessions");
			}
		},
		[conversationId, startNewChat, clearMessages],
	);

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
							...(m.role === "assistant"
								? { parts: blocksToParts(m.content) }
								: {}),
						})),
					);
					return;
				}
			} catch {
				/* keep trying */
			}
		}
		if (conversationIdRef.current !== convId) return;
		// Gave up — leave a gentle note rather than a hard error.
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
		if (!text) return;

		// While a turn is streaming, a send INJECTS into it instead of starting a
		// new turn; the running turn picks it up at the next round boundary.
		if (isStreaming) {
			if (!conversationId) return;
			// Drop the injection inline into the streaming assistant turn, where it
			// was typed — not hoisted above the whole reply. The backend records it
			// as an `injected` block at the same spot, so reloads match.
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
			setInputHeight(INPUT_MIN_H);
			scrollToBottom(true);
			try {
				await injectMessage(conversationId, text);
			} catch {
				/* 409 = the turn just ended; best-effort */
			}
			return;
		}

		// Ensure a conversation exists (create with the default agent on first send).
		let convId = conversationId;
		if (!convId) {
			try {
				const conv = await createConversation({
					agent: agentKind,
					...(modelId ? { model_id: modelId } : {}),
				});
				convId = conv.id;
				setConversationId(conv.id);
				await AsyncStorage.setItem(CONV_STORAGE_KEY, conv.id);
			} catch {
				setMessages((c) => [
					...c,
					{
						id: newMessageId(),
						role: "assistant",
						parts: [
							{
								kind: "text",
								id: "p0",
								text: "**Error:** failed to start conversation",
							},
						],
					},
				]);
				return;
			}
		}

		const context = contextAttached && notePath ? [notePath] : [];
		const contextNoteIds = contextAttached && noteId ? [noteId] : [];
		const userMsg = {
			id: newMessageId(),
			role: "user",
			content: text,
			...(context.length ? { context } : {}),
		};
		const assistantMsg = {
			id: newMessageId(),
			role: "assistant",
			parts: [],
		};
		setMessages((curr) => [...curr, userMsg, assistantMsg]);
		setInput("");
		setInputHeight(INPUT_MIN_H);
		setIsStreaming(true);
		// Sending re-arms the stick-to-bottom lock so the new turn scrolls into view.
		scrollToBottom(true);

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
				contextNoteIds,
				signal: controller.signal,
				onText: appendText,
				onThinking: () => {},
				onTool: (evt) => {
					// `navigate` renders a "Go" action, not a tool chip — handle it up
					// front (only on announce; ignore the nameless `done` frame).
					if (evt.name === "navigate") {
						if (evt.done) return;
						setMessages((curr) => {
							const updated = [...curr];
							const last = { ...updated[updated.length - 1] };
							const parts = [...(last.parts || [])];
							const a = evt.args || {};
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
						const last = updated[updated.length - 1];
						updated[updated.length - 1] = {
							...last,
							parts: applyToolEventToParts(last.parts, evt),
						};
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
			setIsStreaming(false);
			abortRef.current = null;
		}
	}, [
		input,
		isStreaming,
		conversationId,
		agentKind,
		contextAttached,
		notePath,
		noteId,
		scrollToBottom,
		modelId,
		recoverTurn,
	]);

	// Composer button is state-driven: STOP while streaming with an empty box,
	// otherwise SEND (which injects when streaming, sends a new turn when idle).
	const hasText = input.trim().length > 0;
	const showStop = isStreaming && !hasText;
	const canSend = hasText;

	return (
		<KeyboardAvoidingView
			style={styles.container}
			behavior="translate-with-padding"
		>
			<SafeAreaView style={styles.safeTop} edges={["top"]}>
				<View style={styles.container}>
					<View style={styles.header}>
						<Pressable onPress={onClose} style={styles.backBtn} hitSlop={8}>
							<Ionicons name="chevron-back" size={16} color={colors.text} />
						</Pressable>
						<View style={styles.headerText}>
							<Text style={styles.headerEyebrow}>chat /</Text>
							<Text style={styles.headerTitle}>{agentLabel}</Text>
						</View>
						<View style={styles.headerStatus}>
							<View
								style={[
									styles.statusDot,
									{
										backgroundColor: isStreaming
											? colors.accent2
											: colors.muted,
									},
								]}
							/>
							<Text style={styles.statusText}>
								{isStreaming ? "streaming" : "idle"}
							</Text>
						</View>
						<Pressable
							onPress={handleClearConversation}
							disabled={messages.length === 0}
							style={({ pressed }) => [
								styles.clearBtn,
								pressed && styles.clearBtnPressed,
								messages.length === 0 && styles.clearBtnDisabled,
							]}
							hitSlop={8}
							accessibilityLabel="New conversation"
						>
							<Ionicons
								name="create-outline"
								size={16}
								color={messages.length === 0 ? colors.muted : colors.text}
							/>
						</Pressable>
					</View>

					<View style={styles.messagesWrap}>
						<ScrollView
							ref={scrollRef}
							style={styles.messages}
							contentContainerStyle={styles.messagesContent}
							onScroll={handleScroll}
							scrollEventThrottle={16}
							onContentSizeChange={() => {
								// Follow growth only when parked at the bottom. Non-animated
								// so rapid streaming tokens track tightly instead of firing
								// a fresh competing animation per token (the old jank).
								if (atBottomRef.current)
									scrollRef.current?.scrollToEnd({ animated: false });
							}}
							keyboardShouldPersistTaps="handled"
						>
							{loadingConv && messages.length === 0 ? (
								<View style={styles.empty}>
									<View style={styles.emptyAvatar}>
										<PiumaRunning pixelSize={3} />
									</View>
									<Text style={styles.emptySub}>loading conversation…</Text>
								</View>
							) : messages.length === 0 ? (
								<View style={styles.empty}>
									<View style={styles.emptyAvatar}>
										<PiumaAvatar pixelSize={3} />
									</View>
									<Text style={styles.emptyTitle}>Ready when you are.</Text>
									<Text style={styles.emptySub}>
										Ask anything — markdown, code, plans. Streams back token by
										token.
									</Text>
								</View>
							) : (
								messages.map((m, i) => {
									const isLast = i === messages.length - 1;
									const isStreamingThis =
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
											parts={m.parts}
											isStreaming={isStreamingThis}
											onNavigate={goTo}
										/>
									);
								})
							)}
						</ScrollView>
						{showJump ? (
							<Pressable
								onPress={() => scrollToBottom(true)}
								style={({ pressed }) => [
									styles.jumpBtn,
									pressed && styles.jumpBtnPressed,
								]}
								hitSlop={8}
								accessibilityLabel="Jump to latest message"
							>
								<Ionicons name="arrow-down" size={16} color={colors.muted} />
							</Pressable>
						) : null}
						{notePath ? (
							<View style={styles.contextBar}>
								<Pressable
									onPress={() => setContextAttached((v) => !v)}
									style={[
										styles.contextTag,
										contextAttached
											? styles.contextTagOn
											: styles.contextTagOff,
									]}
									hitSlop={6}
									accessibilityLabel={
										contextAttached
											? "Note attached as context — tap to detach"
											: "Note detached — tap to attach as context"
									}
								>
									<Text
										style={[
											styles.contextTagIcon,
											!contextAttached && styles.contextTagIconOff,
										]}
									>
										{contextAttached ? "◆" : "◇"}
									</Text>
									<Text
										style={[
											styles.contextTagLabel,
											!contextAttached && styles.contextTagLabelOff,
										]}
										numberOfLines={1}
									>
										{noteTitleFromPath(notePath)}
									</Text>
								</Pressable>
							</View>
						) : null}
					</View>

					{slashMatches.length > 0 ? (
						<View style={[styles.slashMenu, { bottom: composerH + 6 }]}>
							{slashMatches.map((c) => (
								<Pressable
									key={`${c.kind}-${c.name}`}
									onPress={() => runCommand(c)}
									style={({ pressed }) => [
										styles.slashItem,
										pressed && styles.slashItemPressed,
									]}
								>
									<Text
										style={[
											styles.slashName,
											c.kind === "agent" && styles.slashNameAgent,
										]}
									>
										/{c.name}
									</Text>
									<Text style={styles.slashDesc} numberOfLines={1}>
										{c.description}
										{c.kind === "agent" ? " · agent" : ""}
									</Text>
								</Pressable>
							))}
						</View>
					) : null}

					<View
						onLayout={(e) => setComposerH(e.nativeEvent.layout.height)}
						style={[
							styles.composer,
							{ paddingBottom: keyboardVisible ? 10 : insets.bottom + 10 },
						]}
					>
						<View style={styles.composerRow}>
							<TextInput
								style={[
									styles.input,
									{
										// Empty → always one line (ignore the wrapped
										// placeholder's reported height). Otherwise grow
										// with content, capped at ~5 lines.
										height: input
											? Math.min(
													Math.max(inputHeight, INPUT_MIN_H),
													INPUT_MAX_H,
												)
											: INPUT_MIN_H,
									},
								]}
								value={input}
								onChangeText={setInput}
								onContentSizeChange={(e) =>
									setInputHeight(e.nativeEvent.contentSize.height)
								}
								placeholder="Ask anything…"
								placeholderTextColor={colors.muted}
								multiline
								scrollEnabled={inputHeight > INPUT_MAX_H}
								showsVerticalScrollIndicator={false}
							/>
							{showStop ? (
								<Pressable
									onPress={stopStreaming}
									style={({ pressed }) => [
										styles.sendBtn,
										styles.stopBtn,
										pressed && styles.sendBtnPressed,
									]}
									accessibilityLabel="Stop the agent"
								>
									<Text style={[styles.sendLabel, styles.stopLabel]}>
										{STOP_LABEL}
									</Text>
									<Ionicons name="stop" size={14} color={colors.accent3} />
								</Pressable>
							) : (
								<Pressable
									onPress={sendMessage}
									disabled={!canSend}
									style={({ pressed }) => [
										styles.sendBtn,
										!canSend && styles.sendBtnDisabled,
										pressed && canSend && styles.sendBtnPressed,
									]}
								>
									<Text
										style={[
											styles.sendLabel,
											!canSend && styles.sendLabelDisabled,
										]}
									>
										{SUBMIT_LABEL}
									</Text>
									<Ionicons
										name="arrow-up"
										size={14}
										color={canSend ? colors.accent2 : colors.muted}
									/>
								</Pressable>
							)}
						</View>
					</View>
				</View>

				{overlay ? (
					<View style={[styles.floatPicker, { bottom: composerH + 6 }]}>
						<View style={styles.floatHead}>
							<Text style={styles.floatTitle}>
								{overlay === "models"
									? "Pick a model"
									: overlay === "sessions"
										? "Switch conversation"
										: "Rename conversation"}
							</Text>
							<Pressable onPress={() => setOverlay(null)} hitSlop={8}>
								<Text style={styles.floatClose}>×</Text>
							</Pressable>
						</View>
					{overlay === "title" ? (
						<View style={styles.overlayTitleWrap}>
							<Pressable
								onPress={autoRename}
								style={({ pressed }) => [
									styles.overlayAuto,
									pressed && styles.slashItemPressed,
								]}
							>
								<Ionicons
									name="sparkles-outline"
									size={16}
									color={colors.accent2}
								/>
								<View style={{ flex: 1 }}>
									<Text style={styles.overlayAutoText}>
										Auto-rename with AI
									</Text>
									<Text style={styles.overlayAutoDesc}>
										Generate a title from the conversation
									</Text>
								</View>
							</Pressable>
							<Text style={styles.overlayOr}>or edit manually</Text>
							<View style={styles.overlayTitleForm}>
								<TextInput
									style={styles.overlayInput}
									value={titleDraft}
									onChangeText={setTitleDraft}
									placeholder="New title…"
									placeholderTextColor={colors.muted}
									returnKeyType="done"
									onSubmitEditing={saveTitle}
								/>
								<Pressable
									onPress={saveTitle}
									style={({ pressed }) => [
										styles.overlaySave,
										pressed && styles.sendBtnPressed,
									]}
								>
									<Text style={styles.sendLabel}>save</Text>
								</Pressable>
							</View>
						</View>
					) : (
						<>
							<ScrollView
								style={styles.overlayList}
								keyboardShouldPersistTaps="handled"
							>
								{pickList.length === 0 ? (
									<Text style={styles.overlayEmpty}>None</Text>
								) : overlay === "models" ? (
									(() => {
										// In use = the conversation's chosen model, or the admin
										// default when none is set.
										const activeId =
											modelId ?? pickList.find((x) => x.is_default)?.id;
										return pickList.map((m) => {
											const inUse = m.id === activeId;
											return (
												<Pressable
													key={m.id}
													onPress={() => pickModel(m)}
													style={({ pressed }) => [
														styles.overlayRow,
														inUse && styles.overlayRowActive,
														pressed && styles.slashItemPressed,
													]}
												>
													<View style={styles.overlayRowHead}>
														<Text style={styles.overlayRowText}>
															{m.display_name}
														</Text>
														{inUse ? (
															<Text style={styles.overlayRowCheck}>
																✓ in use
															</Text>
														) : null}
													</View>
													<Text style={styles.overlayRowMeta} numberOfLines={1}>
														{m.provider}
														{m.is_default ? " · default" : ""}
													</Text>
												</Pressable>
											);
										});
									})()
								) : (
									pickList.map((c) => (
										<View key={c.id} style={styles.overlaySessionRow}>
											<Pressable
												onPress={() => switchConversation(c.id)}
												style={({ pressed }) => [
													styles.overlaySessionMain,
													pressed && styles.slashItemPressed,
												]}
											>
												<Text style={styles.overlayRowText} numberOfLines={1}>
													{c.title || "Untitled"}
												</Text>
											</Pressable>
											<Pressable
												onPress={() => removeConversation(c.id)}
												hitSlop={8}
												style={({ pressed }) => [
													styles.overlayDel,
													pressed && styles.slashItemPressed,
												]}
											>
												<Ionicons
													name="trash-outline"
													size={16}
													color={colors.accent3}
												/>
											</Pressable>
										</View>
									))
								)}
							</ScrollView>
							{overlay === "sessions" ? (
								<TextInput
									style={styles.overlaySearch}
									value={sessionQuery}
									onChangeText={setSessionQuery}
									placeholder="Search title or message text…"
									placeholderTextColor={colors.muted}
									autoFocus
									returnKeyType="search"
								/>
							) : null}
						</>
					)}
					</View>
				) : null}
			</SafeAreaView>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	safeTop: { flex: 1, backgroundColor: colors.bg, paddingTop: TOP_EXTRA },
	container: { flex: 1, backgroundColor: colors.bg },

	header: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderBottomWidth: 2,
		borderBottomColor: colors.borderStrong,
		borderStyle: "dashed",
		backgroundColor: colors.panel,
	},
	backBtn: {
		width: 30,
		height: 30,
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		alignItems: "center",
		justifyContent: "center",
	},
	headerText: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: 6 },
	headerEyebrow: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 10,
		fontWeight: "800",
		letterSpacing: 1.2,
		textTransform: "uppercase",
	},
	headerTitle: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "900",
		letterSpacing: 0.5,
	},
	headerStatus: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 8,
		paddingVertical: 4,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
	},
	clearBtn: {
		width: 30,
		height: 30,
		alignItems: "center",
		justifyContent: "center",
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
	},
	clearBtnPressed: {
		transform: [{ translateX: 1 }, { translateY: 1 }],
		backgroundColor: colors.panel,
	},
	clearBtnDisabled: {
		opacity: 0.4,
	},
	statusDot: { width: 6, height: 6 },
	statusText: {
		fontFamily: MONO,
		color: colors.muted,
		fontSize: 10,
		fontWeight: "800",
		letterSpacing: 0.8,
		textTransform: "uppercase",
	},

	messagesWrap: { flex: 1, position: "relative" },
	messages: { flex: 1 },
	messagesContent: {
		paddingHorizontal: 12,
		paddingTop: 16,
		paddingBottom: 24,
		gap: 18,
	},

	empty: { alignItems: "center", paddingTop: 48, gap: 12 },
	emptyAvatar: {
		padding: 8,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.panel,
	},
	emptyTitle: {
		color: colors.accent,
		fontFamily: MONO,
		fontWeight: "900",
		fontSize: 16,
		textShadowColor: "#000",
		textShadowOffset: { width: 2, height: 2 },
		textShadowRadius: 0,
	},
	emptySub: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 12,
		textAlign: "center",
		paddingHorizontal: 32,
		lineHeight: 18,
	},

	// ── USER bubble ─────────────────────────────────────────
	userRow: {
		flexDirection: "row",
		justifyContent: "flex-end",
	},
	// Column so the context chip can sit UNDER the bubble, both right-aligned.
	userCol: {
		maxWidth: "82%",
		alignItems: "flex-end",
		gap: 4,
	},
	userCard: {
		paddingHorizontal: 14,
		paddingVertical: 10,
		borderWidth: 1,
		borderColor: "rgba(247, 201, 72, 0.32)",
		backgroundColor: "rgba(247, 201, 72, 0.08)",
	},
	userText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		lineHeight: 22,
	},

	// ── ASSISTANT bubble ────────────────────────────────────
	assistantBody: { alignSelf: "stretch", minWidth: 0 },
	assistantRoleLabel: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 10,
		fontWeight: "800",
		letterSpacing: 1.2,
		textTransform: "uppercase",
		marginBottom: 6,
	},

	// ── INLINE INJECTION (a user message dropped mid-turn) ─
	inject: {
		flexDirection: "row",
		alignItems: "baseline",
		gap: 8,
		marginVertical: 8,
		paddingVertical: 6,
		paddingHorizontal: 10,
		borderLeftWidth: 2,
		borderLeftColor: colors.accent4,
		backgroundColor: colors.bgSoft,
	},
	injectLabel: {
		fontFamily: MONO,
		fontSize: 10,
		fontWeight: "800",
		letterSpacing: 0.5,
		textTransform: "uppercase",
		color: colors.accent4,
	},
	injectText: { flex: 1, color: colors.text, fontFamily: MONO, fontSize: 13 },
	navAction: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "flex-start",
		gap: 6,
		marginVertical: 6,
		paddingVertical: 6,
		paddingHorizontal: 12,
		borderWidth: 1,
		borderColor: colors.accent,
		borderRadius: 4,
		backgroundColor: colors.bgSoft,
	},
	navActionIcon: { color: colors.accent, fontFamily: MONO, fontSize: 14 },
	navActionLabel: { color: colors.text, fontFamily: MONO, fontSize: 13 },

	// ── TOOL ACTIVITY (which plugins the agent ran this turn) ─
	tools: {
		flexDirection: "row",
		flexWrap: "wrap",
		alignItems: "flex-start",
		gap: 4,
		marginBottom: 10,
	},
	// Collapsed one-line summary shown after the turn settles.
	toolsWrap: { marginBottom: 10 },
	toolsSummary: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		alignSelf: "flex-start",
		maxWidth: "100%",
		paddingHorizontal: 8,
		paddingVertical: 4,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
	},
	toolsSummaryErr: { borderColor: "rgba(255, 107, 107, 0.4)" },
	toolsSummaryCaret: { color: colors.muted, fontFamily: MONO, fontSize: 11 },
	toolsSummaryText: {
		flexShrink: 1,
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
	},
	tool: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		alignSelf: "flex-start",
		maxWidth: "100%",
		paddingHorizontal: 8,
		paddingVertical: 3,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
	},
	tool_running: { borderColor: "rgba(131, 255, 146, 0.42)" },
	tool_done: { borderColor: colors.border },
	tool_error: { borderColor: "rgba(255, 107, 107, 0.4)" },
	toolIcon: { fontFamily: MONO, fontSize: 10, color: colors.muted },
	toolIcon_running: { color: colors.accent2 },
	toolIcon_done: { color: colors.accent2 },
	toolIcon_error: { color: colors.accent3 },
	toolName: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "800",
		letterSpacing: 0.3,
	},
	toolArgs: {
		flexShrink: 1,
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
	},

	// ── COMPOSER ─────────────────────────────────────────────
	composer: {
		flexDirection: "column",
		gap: 8,
		paddingHorizontal: 12,
		paddingTop: 10,
		borderTopWidth: 2,
		borderTopColor: colors.borderStrong,
		borderStyle: "dashed",
		backgroundColor: colors.panel,
	},
	composerRow: {
		flexDirection: "row",
		alignItems: "stretch",
		gap: 8,
	},

	// ── JUMP TO LATEST (shown when scrolled up) ──────────────
	jumpBtn: {
		position: "absolute",
		bottom: 12,
		// Anchored bottom-LEFT, opposite the right-aligned context chip, so the
		// two never overlap (the chip can be wide).
		left: 12,
		width: 32,
		height: 32,
		alignItems: "center",
		justifyContent: "center",
		// Subtle: translucent fill + faint border, so it floats over the chat
		// without competing with the content.
		backgroundColor: "rgba(20, 23, 28, 0.5)",
		borderWidth: 1,
		borderColor: colors.border,
		opacity: 0.65,
	},
	jumpBtnPressed: {
		transform: [{ translateX: 1 }, { translateY: 1 }],
		opacity: 1,
	},

	// ── CONTEXT TAG (attached note) ──────────────────────────
	contextBar: {
		// Float at the bottom-right of the messages area. It's anchored to the
		// bottom of the chat wrapper, which sits ABOVE the composer — and the
		// composer already reserves the Android system-nav-bar inset in its
		// paddingBottom — so the chip never collides with the nav bar.
		position: "absolute",
		right: 12,
		bottom: 8,
		// Hard cap so a long note title crops (label ellipsizes) instead of
		// stretching across and covering the chat. Stays right-anchored.
		maxWidth: 220,
		flexDirection: "row",
		flexWrap: "wrap",
		justifyContent: "flex-end",
		gap: 6,
	},
	contextTag: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		maxWidth: "100%",
		paddingHorizontal: 8,
		paddingVertical: 4,
		borderWidth: 1,
		// Solid background — the chip floats over the chat, so it must be opaque
		// to keep message text from bleeding through behind it.
		backgroundColor: colors.panel,
	},
	contextTagOn: {
		borderColor: colors.accent2,
	},
	contextTagOff: {
		borderColor: colors.border,
		borderStyle: "dashed",
	},
	contextTagIcon: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "900",
	},
	contextTagIconOff: { color: colors.muted },
	contextTagLabel: {
		flexShrink: 1,
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "800",
		letterSpacing: 0.4,
	},
	contextTagLabelOff: { color: colors.muted },

	// Read-only context chip shown inside a sent user bubble.
	bubbleContextRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		justifyContent: "flex-end",
		gap: 4,
	},
	// Small read-only chip shown under a sent user bubble.
	bubbleContextTag: {
		flexDirection: "row",
		alignItems: "center",
		gap: 3,
		// Cap each chip so long titles crop rather than overrunning the row.
		maxWidth: 200,
		paddingHorizontal: 5,
		paddingVertical: 1,
		borderWidth: 1,
		borderColor: "rgba(92, 208, 169, 0.4)",
		backgroundColor: "rgba(92, 208, 169, 0.08)",
	},
	bubbleContextIcon: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 8,
		fontWeight: "900",
	},
	bubbleContextLabel: {
		flexShrink: 1,
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 9,
		fontWeight: "700",
		letterSpacing: 0.2,
	},
	input: {
		flex: 1,
		minHeight: 44,
		maxHeight: 140,
		backgroundColor: colors.bg,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 10,
		paddingVertical: 10,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		lineHeight: 20,
		textAlignVertical: "top",
	},
	sendBtn: {
		minWidth: 96,
		paddingHorizontal: 12,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.accent2,
	},
	sendBtnDisabled: {
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	sendBtnPressed: {
		transform: [{ translateX: 1 }, { translateY: 1 }],
	},
	// STOP variant of the action button — red border/label.
	stopBtn: {
		borderColor: colors.accent3,
		backgroundColor: "rgba(255, 107, 107, 0.08)",
	},
	stopLabel: { color: colors.accent3 },
	sendLabel: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "900",
		letterSpacing: 0.8,
		textTransform: "uppercase",
	},
	sendLabelDisabled: { color: colors.muted },

	// ── SLASH COMMAND MENU ───────────────────────────────────
	// Floating pickers (slash list + sessions/models/rename) — anchored just above
	// the composer (bottom set inline from the measured composer height), so they
	// overlay the chat instead of pushing the input down. Mirrors the web chat.
	slashMenu: {
		position: "absolute",
		left: 12,
		right: 12,
		zIndex: 60,
		elevation: 16,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.panel,
		maxHeight: 240,
	},
	floatPicker: {
		position: "absolute",
		left: 12,
		right: 12,
		zIndex: 60,
		elevation: 16,
		maxHeight: 420,
		padding: 8,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 6,
		backgroundColor: colors.panel,
	},
	floatHead: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: 6,
	},
	floatTitle: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
	},
	floatClose: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 18,
		paddingHorizontal: 4,
	},
	slashItem: {
		flexDirection: "row",
		alignItems: "baseline",
		gap: 8,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderBottomWidth: 1,
		borderBottomColor: colors.bgSoft,
	},
	slashItemPressed: { backgroundColor: colors.bgSoft },
	slashName: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 13,
		fontWeight: "800",
	},
	// Agent-specific commands use a distinct hue vs the global/client ones.
	slashNameAgent: { color: colors.accent4 },
	slashDesc: {
		flexShrink: 1,
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 12,
	},

	// ── OVERLAY (models / sessions / rename) ─────────────────
	overlayList: { maxHeight: 320 },
	overlaySearch: {
		minHeight: 42,
		marginTop: 8,
		backgroundColor: colors.bg,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 10,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
	},
	overlayEmpty: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 12,
		paddingVertical: 12,
		textAlign: "center",
	},
	overlayRow: {
		paddingHorizontal: 8,
		paddingVertical: 10,
		borderBottomWidth: 1,
		borderBottomColor: colors.bgSoft,
	},
	// Highlight the model the conversation is currently using.
	overlayRowActive: {
		borderLeftWidth: 2,
		borderLeftColor: colors.accent2,
		backgroundColor: colors.bgSoft,
	},
	overlayRowHead: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
	},
	overlayRowCheck: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "800",
		letterSpacing: 0.4,
	},
	// Session row: title (fills) + a delete button on the right.
	overlaySessionRow: {
		flexDirection: "row",
		alignItems: "center",
		borderBottomWidth: 1,
		borderBottomColor: colors.bgSoft,
	},
	overlaySessionMain: {
		flex: 1,
		paddingHorizontal: 8,
		paddingVertical: 10,
	},
	overlayDel: {
		paddingHorizontal: 10,
		paddingVertical: 10,
	},
	overlayRowText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
	},
	overlayRowMeta: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		marginTop: 2,
	},
	overlayTitleWrap: { gap: 10 },
	overlayAuto: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 10,
		paddingVertical: 10,
		backgroundColor: colors.bg,
		borderWidth: 2,
		borderColor: colors.accent2,
	},
	overlayAutoText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "800",
	},
	overlayAutoDesc: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		marginTop: 2,
	},
	overlayOr: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		textAlign: "center",
	},
	overlayTitleForm: {
		flexDirection: "row",
		gap: 8,
		alignItems: "stretch",
	},
	overlayInput: {
		flex: 1,
		minHeight: 44,
		backgroundColor: colors.bg,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 10,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
	},
	overlaySave: {
		minWidth: 80,
		paddingHorizontal: 12,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.accent2,
	},
});
