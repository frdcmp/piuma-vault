import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
	Animated,
	BackHandler,
	Dimensions,
	Keyboard,
	PanResponder,
	Pressable,
	StyleSheet,
	TouchableOpacity,
	View,
} from "react-native";
import EmptyState from "../components/EmptyState";
import NoteEditor from "../components/NoteEditor";
import NotesListPanel from "../components/NotesListPanel";
import { useTopInset } from "../components/SystemBars";
import { useNote, useNotesLiveUpdates } from "../queries/notesQuery";
import { useAuthStore } from "../stores/authStore";
import { colors } from "../utils/theme";
import ChatScreen from "./ChatScreen";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCREEN_W = Dimensions.get("window").width;
const DRAWER_W = Math.round(SCREEN_W * 0.85);
// The chat (right) drawer is full width — it covers the whole screen up to the
// left border, unlike the notes (left) drawer which stays at DRAWER_W.
const CHAT_DRAWER_W = SCREEN_W;
const LEFT_CLOSED = -DRAWER_W;
const LEFT_OPEN = 0;
const RIGHT_CLOSED = SCREEN_W;
const RIGHT_OPEN = SCREEN_W - CHAT_DRAWER_W;
const SNAP_DURATION = 220;
const GESTURE_THRESHOLD = 12;
const FLICK_VELOCITY = 0.5;

// Builds the human-readable "vault path" for chat context. Folder root has no
// prefix, so a top-level note becomes "/Untitled" rather than "//Untitled".
const formatNotePath = (note) => {
	if (!note) return null;
	const title = note.title || "Untitled";
	if (!note.folder || note.folder === "/") return `/${title}`;
	return `${note.folder}/${title}`;
};

function EmptyHeader({ onMenu, onChat }) {
	const topInset = useTopInset();
	return (
		<View style={[styles.emptyHeader, { paddingTop: topInset + 6 }]}>
			<TouchableOpacity onPress={onMenu} style={styles.headerCol} hitSlop={10}>
				<Ionicons name="menu" size={24} color={colors.text} />
			</TouchableOpacity>
			<TouchableOpacity onPress={onChat} style={styles.headerCol} hitSlop={10}>
				<Ionicons
					name="chatbubble-ellipses-outline"
					size={22}
					color={colors.text}
				/>
			</TouchableOpacity>
		</View>
	);
}

export default function VaultHomeScreen({ navigation, route }) {
	const logout = useAuthStore((s) => s.logout);

	// selection.id: null = empty, 'new' = creating, uuid = existing.
	// selection.session bumps only on explicit switch, so the post-create id
	// swap (new → uuid) doesn't remount the editor and lose in-flight edits.
	const [selection, setSelection] = useState({ id: null, session: 0 });

	// Live updates: one SSE subscription for the whole notes screen — feeds
	// both the sidebar list and the open note's editor.
	useNotesLiveUpdates(UUID_RE.test(selection.id) ? selection.id : null);

	// Selected note → vault path for chat context injection.
	const noteQuery = useNote(UUID_RE.test(selection.id) ? selection.id : null);
	const notePath = formatNotePath(noteQuery.data);

	// Two drawers, one open at a time. `openDrawer` drives React (pointerEvents,
	// scrim activation); `openDrawerRef` mirrors it for synchronous reads inside
	// the pan responder callbacks (which capture stale state otherwise).
	const [openDrawer, setOpenDrawer] = useState(null); // null | 'left' | 'right'
	const openDrawerRef = useRef(null);

	const leftX = useRef(new Animated.Value(LEFT_CLOSED)).current;
	const rightX = useRef(new Animated.Value(RIGHT_CLOSED)).current;
	const leftValueRef = useRef(LEFT_CLOSED);
	const rightValueRef = useRef(RIGHT_CLOSED);
	const leftStartRef = useRef(LEFT_CLOSED);
	const rightStartRef = useRef(RIGHT_CLOSED);
	const gestureSideRef = useRef(null); // 'left' or 'right' for the active gesture

	useEffect(() => {
		const idL = leftX.addListener(({ value }) => {
			leftValueRef.current = value;
		});
		const idR = rightX.addListener(({ value }) => {
			rightValueRef.current = value;
		});
		return () => {
			leftX.removeListener(idL);
			rightX.removeListener(idR);
		};
	}, [leftX, rightX]);

	const animate = (animValue, toValue) =>
		Animated.timing(animValue, {
			toValue,
			duration: SNAP_DURATION,
			useNativeDriver: true,
		});

	const setOpen = (which) => {
		openDrawerRef.current = which;
		setOpenDrawer(which);
	};

	const openLeft = () => {
		// Force-close the right drawer so two drawers can never coexist.
		animate(rightX, RIGHT_CLOSED).start();
		animate(leftX, LEFT_OPEN).start();
		setOpen("left");
	};

	const openRight = () => {
		Keyboard.dismiss();
		animate(leftX, LEFT_CLOSED).start();
		animate(rightX, RIGHT_OPEN).start();
		setOpen("right");
	};

	const closeDrawers = () => {
		Keyboard.dismiss();
		animate(leftX, LEFT_CLOSED).start();
		animate(rightX, RIGHT_CLOSED).start();
		setOpen(null);
	};

	// Deep-link: a `noteId` route param (set by a chat note link / navigate Go)
	// opens that note and closes the chat drawer so it's visible, then clears the
	// param so it doesn't reopen on the next focus.
	const deepNoteId = route?.params?.noteId;
	// biome-ignore lint/correctness/useExhaustiveDependencies: open once per deep-link id
	useEffect(() => {
		if (!deepNoteId || !UUID_RE.test(deepNoteId)) return;
		setSelection((s) => ({ id: deepNoteId, session: s.session + 1 }));
		closeDrawers();
		navigation.setParams({ noteId: undefined });
	}, [deepNoteId]);

	// Android back: close the open drawer first, then let the system handle it
	// (which exits the screen / app at the root).
	useEffect(() => {
		const sub = BackHandler.addEventListener("hardwareBackPress", () => {
			if (openDrawerRef.current !== null) {
				closeDrawers();
				return true;
			}
			return false;
		});
		return () => sub.remove();
	}, []);

	const handleSelectNote = (id) => {
		setSelection((prev) => ({ id, session: prev.session + 1 }));
		closeDrawers();
	};

	const handleNewNote = () => {
		setSelection((prev) => ({ id: "new", session: prev.session + 1 }));
		closeDrawers();
	};

	const handleEditorCreated = (id) => {
		// Keep session stable so the editor doesn't remount mid-save.
		setSelection((prev) => ({ id, session: prev.session }));
	};

	const handleDeleted = () => {
		setSelection((prev) => ({ id: null, session: prev.session + 1 }));
	};

	const handleExitNote = () => {
		setSelection((prev) => ({ id: null, session: prev.session + 1 }));
	};

	// Decide whether (and which) drawer this horizontal swipe controls.
	// Closed: rightward → left drawer, leftward → right drawer.
	// Open: only the gesture that closes the open drawer is honored — you can't
	// swipe past one drawer to open the other.
	const shouldClaim = (g) => {
		if (Math.abs(g.dy) > Math.abs(g.dx)) return false;
		if (Math.abs(g.dx) < GESTURE_THRESHOLD) return false;
		const open = openDrawerRef.current;
		if (open === "left") {
			if (g.dx < 0) {
				gestureSideRef.current = "left";
				return true;
			}
			return false;
		}
		if (open === "right") {
			if (g.dx > 0) {
				gestureSideRef.current = "right";
				return true;
			}
			return false;
		}
		if (g.dx > 0) {
			gestureSideRef.current = "left";
			return true;
		}
		gestureSideRef.current = "right";
		return true;
	};

	const responder = useRef(
		PanResponder.create({
			onMoveShouldSetPanResponder: (_, g) => shouldClaim(g),
			onMoveShouldSetPanResponderCapture: (_, g) => shouldClaim(g),
			onPanResponderGrant: () => {
				Keyboard.dismiss();
				leftStartRef.current = leftValueRef.current;
				rightStartRef.current = rightValueRef.current;
			},
			onPanResponderMove: (_, g) => {
				const side = gestureSideRef.current;
				if (side === "left") {
					const next = Math.min(
						LEFT_OPEN,
						Math.max(LEFT_CLOSED, leftStartRef.current + g.dx),
					);
					leftX.setValue(next);
				} else if (side === "right") {
					const next = Math.max(
						RIGHT_OPEN,
						Math.min(RIGHT_CLOSED, rightStartRef.current + g.dx),
					);
					rightX.setValue(next);
				}
			},
			onPanResponderRelease: (_, g) => {
				const side = gestureSideRef.current;
				gestureSideRef.current = null;
				if (side === "left") {
					// Flick decides regardless of position; otherwise snap to the
					// nearest edge.
					if (g.vx > FLICK_VELOCITY) return openLeft();
					if (g.vx < -FLICK_VELOCITY) return closeDrawers();
					if (leftValueRef.current > LEFT_CLOSED / 2) return openLeft();
					return closeDrawers();
				}
				if (side === "right") {
					if (g.vx < -FLICK_VELOCITY) return openRight();
					if (g.vx > FLICK_VELOCITY) return closeDrawers();
					if (rightValueRef.current < RIGHT_OPEN + CHAT_DRAWER_W / 2)
						return openRight();
					return closeDrawers();
				}
			},
			onPanResponderTerminationRequest: () => false,
		}),
	).current;

	const scrimOpacityLeft = leftX.interpolate({
		inputRange: [LEFT_CLOSED, LEFT_OPEN],
		outputRange: [0, 0.5],
		extrapolate: "clamp",
	});
	const scrimOpacityRight = rightX.interpolate({
		inputRange: [RIGHT_OPEN, RIGHT_CLOSED],
		outputRange: [0.5, 0],
		extrapolate: "clamp",
	});

	const isEditingExisting = selection.id && selection.id !== "new";
	const editorNoteId = isEditingExisting ? selection.id : undefined;
	const hasEditor = selection.id != null;

	return (
		<View style={styles.root} {...responder.panHandlers}>
			<View style={styles.main}>
				{hasEditor ? (
					<NoteEditor
						key={selection.session}
						noteId={editorNoteId}
						onOpenDrawer={openLeft}
						onOpenChat={openRight}
						onDeleted={handleDeleted}
						onCreated={handleEditorCreated}
						onExit={handleExitNote}
					/>
				) : (
					<View style={styles.emptyMain}>
						<EmptyHeader onMenu={openLeft} onChat={openRight} />
						<EmptyState
							onFiles={openLeft}
							onChat={openRight}
							onStorage={() => navigation.navigate("Storage")}
							onTasks={() => navigation.navigate("Tasks")}
							onCalendar={() => navigation.navigate("Calendar")}
							onRecorder={() => navigation.navigate("Recorder")}
							onSettings={() => navigation.navigate("Settings")}
							onLogout={logout}
						/>
					</View>
				)}
			</View>

			<Animated.View
				pointerEvents={openDrawer === "left" ? "auto" : "none"}
				style={[styles.scrim, { opacity: scrimOpacityLeft }]}
			>
				<Pressable style={StyleSheet.absoluteFill} onPress={closeDrawers} />
			</Animated.View>
			<Animated.View
				pointerEvents={openDrawer === "right" ? "auto" : "none"}
				style={[styles.scrim, { opacity: scrimOpacityRight }]}
			>
				<Pressable style={StyleSheet.absoluteFill} onPress={closeDrawers} />
			</Animated.View>

			<Animated.View
				style={[
					styles.leftDrawer,
					{ width: DRAWER_W, transform: [{ translateX: leftX }] },
				]}
			>
				<NotesListPanel
					selectedNoteId={isEditingExisting ? selection.id : null}
					onSelectNote={handleSelectNote}
					onNewNote={handleNewNote}
				/>
			</Animated.View>

			<Animated.View
				style={[
					styles.rightDrawer,
					{ width: CHAT_DRAWER_W, transform: [{ translateX: rightX }] },
				]}
			>
				<ChatScreen
					notePath={notePath}
					noteId={editorNoteId}
					onClose={closeDrawers}
				/>
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" },
	main: { flex: 1 },
	emptyMain: { flex: 1, backgroundColor: colors.bg },
	emptyHeader: {
		flexDirection: "row",
		alignItems: "flex-start",
		justifyContent: "space-between",
		paddingHorizontal: 8,
		paddingBottom: 6,
	},
	headerCol: {
		alignItems: "center",
		paddingHorizontal: 8,
		paddingVertical: 6,
	},
	scrim: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: "#000",
	},
	leftDrawer: {
		position: "absolute",
		top: 0,
		left: 0,
		bottom: 0,
		backgroundColor: colors.bg,
		borderRightWidth: 1,
		borderRightColor: colors.border,
		shadowColor: "#000",
		shadowOffset: { width: 2, height: 0 },
		shadowOpacity: 0.4,
		shadowRadius: 8,
		elevation: 12,
	},
	rightDrawer: {
		position: "absolute",
		top: 0,
		left: 0,
		bottom: 0,
		backgroundColor: colors.bg,
		elevation: 12,
	},
});
