import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Keyboard,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import {
	SafeAreaView,
	useSafeAreaInsets,
} from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
	createConversation,
	fetchConversation,
	fetchDefaultAgent,
	streamChat,
} from "../api/agentChatApi";
import MarkdownView from "../components/MarkdownView";
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

// Restores the active agents conversation across mounts.
const CONV_STORAGE_KEY = "agents_active_conv";

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

// Map a gateway transcript entry ({role, content, context?}) to our UI message
// shape. The backend recovers the per-turn note chip from the stored <context>
// block; `tools` activity isn't persisted, so reloaded assistant turns get an
// empty tool list.
const historyToMessage = (m) => ({
	id: newMessageId(),
	role: m.role,
	content: m.content,
	...(m.context?.length ? { context: m.context } : {}),
	...(m.role === "assistant" ? { tools: [] } : {}),
});

const escapeXmlAttr = (value) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

// Wrap a turn's text with its attached note as a structured <context> block,
// byte-identical to the web composer (frontend/src/chat/ChatPanel.jsx) so the
// gateway gets the same parseable delimiters and resolves note paths the same.
const withContextBlock = (content, context) => {
	if (!context?.length) return content;
	const notes = context
		.map((p) => `  <note path="${escapeXmlAttr(p)}" />`)
		.join("\n");
	return `<context>\n${notes}\n</context>\n\n${content}`;
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
	const prev = next[idx];
	next[idx] =
		prev.status === "done" || prev.status === "error"
			? { ...prev, ...entry, status: prev.status }
			: { ...prev, ...entry };
	return next;
};

const TOOL_GLYPH = { running: "⛏", done: "✓", error: "✕" };

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
function ToolActivity({ tools }) {
	if (!tools?.length) return null;
	return (
		<View style={styles.tools}>
			{tools.map((t) => (
				<View key={t.id} style={[styles.tool, styles[`tool_${t.status}`]]}>
					<Text style={[styles.toolIcon, styles[`toolIcon_${t.status}`]]}>
						{TOOL_GLYPH[t.status] || "⛏"}
					</Text>
					<Text style={styles.toolName}>{t.name}</Text>
					{t.args ? (
						<Text style={styles.toolArgs} numberOfLines={1}>
							{t.args}
						</Text>
					) : null}
				</View>
			))}
		</View>
	);
}

function AssistantBubble({ content, tools, isStreaming }) {
	const { text: visible, isAnimating } = useProgressiveText(content || "");
	const showCursor = isStreaming || isAnimating;
	const isEmpty = !visible;

	// Avatar only appears while the dog is "thinking" — the ThinkingLoader
	// owns its own avatar tile, so we don't draw a second one alongside it.
	if (isEmpty && isStreaming) {
		return (
			<View style={styles.assistantBody}>
				<Text style={styles.assistantRoleLabel}>{ASSISTANT_LABEL}</Text>
				<ToolActivity tools={tools} />
				<ThinkingLoader label={`${AGENT_LABEL} is sniffing the trail`} />
			</View>
		);
	}

	return (
		<View style={styles.assistantBody}>
			<Text style={styles.assistantRoleLabel}>{ASSISTANT_LABEL}</Text>
			<ToolActivity tools={tools} />
			<View>
				<MarkdownView source={visible} textStyle={chatMarkdownTextStyle} />
				{showCursor ? <StreamingCursor /> : null}
			</View>
		</View>
	);
}

export default function ChatScreen({ onClose, notePath, noteId }) {
	const insets = useSafeAreaInsets();
	const [messages, setMessages] = useState([]);
	const [input, setInput] = useState("");
	const [inputHeight, setInputHeight] = useState(INPUT_MIN_H);
	const [isStreaming, setIsStreaming] = useState(false);
	const [keyboardVisible, setKeyboardVisible] = useState(false);
	// Active agents conversation + the agent for new chats (admin default).
	const [conversationId, setConversationId] = useState(null);
	const [agentKind, setAgentKind] = useState("vault_agent");
	// The open note is attached as context by default; tapping the chip toggles
	// it off for the next send. Mobile keeps it to a single note (no tabs, no
	// lock state) — the chip just mirrors whatever note opened this chat.
	const [contextAttached, setContextAttached] = useState(true);
	const scrollRef = useRef(null);
	const abortRef = useRef(null);

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
			try {
				const def = await fetchDefaultAgent();
				if (!cancelled && def?.agent) setAgentKind(def.agent);
			} catch {
				/* fall back to vault_agent */
			}
			try {
				const stored = await AsyncStorage.getItem(CONV_STORAGE_KEY);
				if (cancelled || !stored) return;
				const data = await fetchConversation(stored);
				if (cancelled) return;
				setConversationId(stored);
				setMessages(
					(data.messages || []).map((m) => ({
						id: m.id,
						role: m.role,
						content: blocksToText(m.content),
						...(m.role === "assistant" ? { tools: [] } : {}),
					})),
				);
			} catch {
				await AsyncStorage.removeItem(CONV_STORAGE_KEY);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const handleClearConversation = useCallback(() => {
		// Start a new gateway conversation; the old one is orphaned in OpenClaw.
		const wipe = async () => {
			abortRef.current?.abort();
			abortRef.current = null;
			setIsStreaming(false);
			setMessages([]);
			setConversationId(null);
			try {
				await AsyncStorage.removeItem(CONV_STORAGE_KEY);
			} catch {
				/* best-effort */
			}
		};

		const message =
			"This starts a fresh chat. The current conversation stays saved but won't be shown here anymore.";
		if (Platform.OS === "web") {
			// RN Alert on web is a no-op — fall back to window.confirm.
			if (
				typeof window !== "undefined" &&
				window.confirm(`Start a new conversation? ${message}`)
			) {
				wipe();
			}
			return;
		}
		Alert.alert("Start a new conversation?", message, [
			{ text: "Cancel", style: "cancel" },
			{ text: "New chat", style: "destructive", onPress: wipe },
		]);
	}, []);

	const sendMessage = useCallback(async () => {
		const text = input.trim();
		if (!text || isStreaming) return;

		// Ensure a conversation exists (create with the default agent on first send).
		let convId = conversationId;
		if (!convId) {
			try {
				const conv = await createConversation({ agent: agentKind });
				convId = conv.id;
				setConversationId(conv.id);
				await AsyncStorage.setItem(CONV_STORAGE_KEY, conv.id);
			} catch {
				setMessages((c) => [
					...c,
					{
						id: newMessageId(),
						role: "assistant",
						content: "**Error:** failed to start conversation",
						tools: [],
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
			content: "",
			tools: [],
		};
		setMessages((curr) => [...curr, userMsg, assistantMsg]);
		setInput("");
		setInputHeight(INPUT_MIN_H);
		setIsStreaming(true);

		const controller = new AbortController();
		abortRef.current = controller;

		try {
			await streamChat({
				conversationId: convId,
				message: text,
				contextNoteIds,
				signal: controller.signal,
				onText: (delta) => {
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
				onThinking: () => {},
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
				onDone: () => setIsStreaming(false),
			});
		} finally {
			setIsStreaming(false);
			abortRef.current = null;
		}
	}, [input, isStreaming, conversationId, agentKind, contextAttached, notePath, noteId]);

	const canSend = input.trim().length > 0 && !isStreaming;

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
							<Text style={styles.headerTitle}>OpenClaw</Text>
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
						{messages.length > 0 ? (
							<Pressable
								onPress={handleClearConversation}
								style={({ pressed }) => [
									styles.clearBtn,
									pressed && styles.clearBtnPressed,
								]}
								hitSlop={8}
								accessibilityLabel="Clear conversation"
							>
								<Ionicons
									name="trash-outline"
									size={14}
									color={colors.accent3}
								/>
							</Pressable>
						) : null}
					</View>

					<View style={styles.messagesWrap}>
						<ScrollView
							ref={scrollRef}
							style={styles.messages}
							contentContainerStyle={styles.messagesContent}
							onContentSizeChange={() =>
								scrollRef.current?.scrollToEnd({ animated: true })
							}
							keyboardShouldPersistTaps="handled"
						>
							{messages.length === 0 ? (
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
											content={m.content}
											tools={m.tools}
											isStreaming={isStreamingThis}
										/>
									);
								})
							)}
						</ScrollView>
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

					<View
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
								editable={!isStreaming}
							/>
							<Pressable
								onPress={sendMessage}
								disabled={!canSend}
								style={({ pressed }) => [
									styles.sendBtn,
									!canSend && styles.sendBtnDisabled,
									pressed && canSend && styles.sendBtnPressed,
								]}
							>
								{isStreaming ? (
									<ActivityIndicator color={colors.accent2} />
								) : (
									<>
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
									</>
								)}
							</Pressable>
						</View>
					</View>
				</View>
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
		borderColor: "rgba(255, 107, 107, 0.4)",
		backgroundColor: "rgba(255, 107, 107, 0.08)",
	},
	clearBtnPressed: {
		transform: [{ translateX: 1 }, { translateY: 1 }],
		backgroundColor: "rgba(255, 107, 107, 0.18)",
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

	// ── TOOL ACTIVITY (which plugins the agent ran this turn) ─
	tools: { gap: 4, marginBottom: 10 },
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

	// ── CONTEXT TAG (attached note) ──────────────────────────
	contextBar: {
		// Float at the bottom-right of the messages area. It's anchored to the
		// bottom of the chat wrapper, which sits ABOVE the composer — and the
		// composer already reserves the Android system-nav-bar inset in its
		// paddingBottom — so the chip never collides with the nav bar.
		position: "absolute",
		right: 12,
		bottom: 8,
		maxWidth: "75%",
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
		maxWidth: "100%",
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
	sendLabel: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "900",
		letterSpacing: 0.8,
		textTransform: "uppercase",
	},
	sendLabelDisabled: { color: colors.muted },
});
