import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Linking,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { recorderEmbedUrl } from "../api/recorderApi";
import { toast } from "../components/Toast";
import { recorderKeys } from "../queries/recorderQuery";
import { useAuthStore } from "../stores/authStore";
import { colors, mono } from "../utils/theme";

// The live recorder is the web `/recorder` pixel scene (black hole + live
// scrolling transcript) hosted in a WebView — managed Expo can't stream raw PCM
// to the streaming backend, but the browser inside the WebView can. The native
// shell owns the header + navigation; the web page posts lifecycle events back
// over the ReactNativeWebView bridge (see frontend RecorderPage.jsx).

const PHASE_LABEL = {
	idle: "READY",
	connecting: "OPENING…",
	recording: "● REC",
	summarising: "SUMMARISING…",
};
const PHASE_COLOR = {
	idle: colors.muted,
	connecting: colors.accent4,
	recording: colors.accent3,
	summarising: colors.accent,
};

// On the web target, react-native-webview renders as a cross-origin <iframe>,
// which the vault origin blocks (X-Frame-Options: DENY / frame-ancestors 'none').
// The embed only works in a real native WebView (top-level document, not framed),
// so on web we send the user to the page in a real browser tab instead.
const isWeb = Platform.OS === "web";

export default function RecorderScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const qc = useQueryClient();
	const token = useAuthStore((s) => s.token);
	const refreshToken = useAuthStore((s) => s.refreshToken);

	const [phase, setPhase] = useState("idle");
	const [loading, setLoading] = useState(true);
	const webRef = useRef(null);

	// Make sure the OS mic permission is granted before the WebView asks for it
	// (Android's WebView only gets the mic if the app already holds RECORD_AUDIO).
	useEffect(() => {
		let alive = true;
		requestRecordingPermissionsAsync()
			.then((res) => {
				if (alive && res && res.granted === false) {
					toast.error("Microphone access is needed to record");
				}
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	// Seed the web app's auth into the WebView's storage before its scripts run,
	// so it resolves /me (ProtectedRoute) and the WS gets its token without a
	// login bounce. Keys mirror the web axios layer: `token` / `refreshToken`.
	const injectedBefore = useMemo(
		() => `(function(){try{
      window.localStorage.setItem('token', ${JSON.stringify(token || "")});
      window.localStorage.setItem('refreshToken', ${JSON.stringify(refreshToken || "")});
    }catch(e){}})(); true;`,
		[token, refreshToken],
	);

	// Safety net: if the page never signals load (slow link, blocked frame),
	// stop the spinner so the user isn't stuck on it forever.
	useEffect(() => {
		if (isWeb) return;
		const t = setTimeout(() => setLoading(false), 12000);
		return () => clearTimeout(t);
	}, []);

	const openInBrowser = useCallback(() => {
		Linking.openURL(recorderEmbedUrl()).catch(() => {
			toast.error("Couldn't open the recorder");
		});
	}, []);

	const onMessage = useCallback(
		(event) => {
			let msg;
			try {
				msg = JSON.parse(event.nativeEvent.data);
			} catch {
				return;
			}
			if (msg.type === "phase") {
				setPhase(msg.phase || "idle");
			} else if (msg.type === "done") {
				qc.invalidateQueries({ queryKey: recorderKeys.all });
				toast.success("Summary saved to your vault");
				setPhase("idle");
				if (msg.session_id) {
					navigation.navigate("RecordingDetail", { id: msg.session_id });
				} else {
					navigation.navigate("RecorderSessions");
				}
			} else if (msg.type === "error") {
				setPhase("idle");
				toast.error(msg.message || "Recording failed");
			}
		},
		[qc, navigation],
	);

	return (
		<View style={styles.root}>
			<View style={[styles.bar, { paddingTop: insets.top + 12 }]}>
				<Pressable onPress={() => navigation.goBack()} hitSlop={10}>
					<Ionicons name="chevron-back" size={22} color={colors.text} />
				</Pressable>
				<View style={styles.titleWrap}>
					<Text style={styles.title}>Recorder</Text>
					<Text style={[styles.phase, { color: PHASE_COLOR[phase] }]}>
						{PHASE_LABEL[phase] || "READY"}
					</Text>
				</View>
				<Pressable
					onPress={() => navigation.navigate("RecorderSessions")}
					hitSlop={10}
					style={styles.sessionsBtn}
				>
					<Ionicons name="albums-outline" size={16} color={colors.accent4} />
					<Text style={styles.sessionsText}>sessions</Text>
				</Pressable>
			</View>

			{isWeb ? (
				<View style={styles.webFallback}>
					<Text style={styles.fallbackGlyph}>◉</Text>
					<Text style={styles.fallbackTitle}>
						The void lives in a real browser tab
					</Text>
					<Text style={styles.fallbackText}>
						The recorder can't run inside the web preview — the vault origin
						blocks framing. It works in the iOS / Android app, or in a normal
						browser tab.
					</Text>
					<Pressable style={styles.fallbackBtn} onPress={openInBrowser}>
						<Ionicons name="open-outline" size={16} color={colors.bg} />
						<Text style={styles.fallbackBtnText}>open recorder</Text>
					</Pressable>
				</View>
			) : (
				<View style={styles.webWrap}>
					<WebView
						ref={webRef}
						source={{ uri: recorderEmbedUrl() }}
						originWhitelist={["*"]}
						injectedJavaScriptBeforeContentLoaded={injectedBefore}
						onMessage={onMessage}
						onLoadEnd={() => setLoading(false)}
						onError={() => setLoading(false)}
						onHttpError={() => setLoading(false)}
						// Mic capture needs an active media session without a tap gate.
						mediaPlaybackRequiresUserAction={false}
						allowsInlineMediaPlayback
						// iOS: auto-grant getUserMedia (the app already holds mic perm).
						mediaCapturePermissionGrantType="grant"
						javaScriptEnabled
						domStorageEnabled
						// Keep the WebView mounted so capture isn't interrupted by RN.
						androidLayerType="hardware"
						style={styles.web}
						containerStyle={styles.web}
					/>
					{loading && (
						<View style={styles.loader} pointerEvents="none">
							<ActivityIndicator color={colors.accent} />
							<Text style={styles.loaderText}>entering the void…</Text>
						</View>
					)}
				</View>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#0b0c10" },
	bar: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
		backgroundColor: "#0b0c10",
	},
	titleWrap: { flex: 1, marginLeft: 12 },
	title: { color: colors.text, fontSize: 17, fontWeight: "600" },
	phase: {
		fontFamily: mono,
		fontSize: 10,
		fontWeight: "700",
		letterSpacing: 1,
		marginTop: 1,
	},
	sessionsBtn: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 10,
		paddingVertical: 6,
	},
	sessionsText: {
		fontFamily: mono,
		color: colors.accent4,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
	},
	webFallback: {
		flex: 1,
		backgroundColor: "#0b0c10",
		alignItems: "center",
		justifyContent: "center",
		padding: 28,
		gap: 14,
	},
	fallbackGlyph: { color: colors.accent, fontSize: 48, fontFamily: mono },
	fallbackTitle: {
		fontFamily: mono,
		color: colors.text,
		fontSize: 15,
		fontWeight: "700",
		textAlign: "center",
	},
	fallbackText: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 12,
		lineHeight: 19,
		textAlign: "center",
		maxWidth: 360,
	},
	fallbackBtn: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: 6,
		backgroundColor: colors.accent,
		paddingHorizontal: 16,
		paddingVertical: 10,
	},
	fallbackBtnText: {
		fontFamily: mono,
		color: colors.bg,
		fontSize: 12,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
	},
	webWrap: { flex: 1, backgroundColor: "#0b0c10" },
	web: { flex: 1, backgroundColor: "#0b0c10" },
	loader: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		backgroundColor: "#0b0c10",
	},
	loaderText: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 12,
		letterSpacing: 1,
	},
});
