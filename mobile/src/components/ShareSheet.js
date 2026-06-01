import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
	Dimensions,
	Platform,
	ScrollView,
	Share,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import {
	createShareLink,
	listShareLinks,
	revokeShareLink,
} from "../api/sharesApi";
import { colors } from "../utils/theme";
import BottomSheet from "./BottomSheet";

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "monospace",
});

const SCREEN_H = Dimensions.get("window").height;

// Public site origin — strip the "/api/v1" suffix off the API base so links
// match what the web app produces (https://vault.example.com/share/v/<slug>).
const API_BASE =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";
const SITE_ORIGIN = API_BASE.replace(/\/api\/v1\/?$/, "");

const EXPIRY_OPTIONS = [
	{ value: 1, label: "1 hour" },
	{ value: 24, label: "24 hours" },
	{ value: 72, label: "3 days" },
	{ value: 168, label: "7 days" },
	{ value: 720, label: "30 days" },
];

const buildShareUrl = (share, pwd) => {
	if (!share?.slug) return "";
	const base = `${SITE_ORIGIN}/share/v/${share.slug}`;
	const p = share.has_password && pwd ? pwd : null;
	return p ? `${base}?pwd=${encodeURIComponent(p)}` : base;
};

const buildLlmUrl = (share, pwd) => {
	if (!share?.slug) return "";
	const base = `${API_BASE}/share/v/${share.slug}`;
	const p = share.has_password && pwd ? pwd : null;
	return p ? `${base}?pwd=${encodeURIComponent(p)}` : base;
};

const formatExpiry = (expiresAt) => {
	if (!expiresAt) return "Never";
	const diffMs = new Date(expiresAt).getTime() - Date.now();
	if (diffMs < 0) return "Expired";
	const diffHours = Math.round(diffMs / (1000 * 60 * 60));
	if (diffHours < 1) return "< 1h";
	if (diffHours < 24) return `${diffHours}h`;
	return `${Math.round(diffHours / 24)}d`;
};

/**
 * Share manager for a note, rendered inside the shared BottomSheet. Mirrors the
 * web SharePopover: pick an access level, optionally set a password and/or
 * expiry, generate a link, then share or revoke any active link. Uses the OS
 * share sheet (RN Share API) instead of clipboard so links can be copied or
 * sent anywhere.
 */
export default function ShareSheet({ visible, onClose, noteId, noteTitle }) {
	const [loading, setLoading] = useState(false);
	const [shares, setShares] = useState([]);
	const [lastPassword, setLastPassword] = useState(null);

	const [accessLevel, setAccessLevel] = useState("view");
	const [password, setPassword] = useState("");
	const [expiresIn, setExpiresIn] = useState(24);
	const [passwordEnabled, setPasswordEnabled] = useState(false);
	const [expireEnabled, setExpireEnabled] = useState(false);

	const loadShares = async () => {
		if (!noteId) return;
		try {
			setShares(await listShareLinks(noteId));
		} catch {
			// silently ignore
		}
	};

	// Reset the form and refresh the list whenever the sheet opens.
	useEffect(() => {
		if (!visible || !noteId) return;
		setLastPassword(null);
		setAccessLevel("view");
		setPassword("");
		setExpiresIn(24);
		setPasswordEnabled(false);
		setExpireEnabled(false);
		listShareLinks(noteId)
			.then(setShares)
			.catch(() => {});
	}, [visible, noteId]);

	const handleGenerate = async () => {
		try {
			setLoading(true);
			const effectivePassword = passwordEnabled ? password || null : null;
			const effectiveExpiry = expireEnabled ? expiresIn : null;
			const created = await createShareLink(noteId, {
				accessLevel,
				password: effectivePassword,
				expiresInHours: effectiveExpiry,
			});
			setLastPassword(effectivePassword);
			await loadShares();

			const url = buildShareUrl(created, effectivePassword);
			if (url) {
				try {
					await Share.share({ message: url });
				} catch {
					// user dismissed the share sheet — link is still active
				}
			}
		} catch {
			// surfaced via the empty list staying unchanged
		} finally {
			setLoading(false);
		}
	};

	const handleShare = async (share, llm = false) => {
		const url = llm
			? buildLlmUrl(share, lastPassword)
			: buildShareUrl(share, lastPassword);
		if (!url) return;
		try {
			await Share.share({ message: url });
		} catch {
			// dismissed
		}
	};

	const handleRevoke = async (shareId) => {
		try {
			await revokeShareLink(shareId);
			await loadShares();
		} catch {
			// ignore
		}
	};

	return (
		<BottomSheet
			visible={visible}
			onClose={onClose}
			title="Share note"
			subtitle={noteTitle}
		>
			<ScrollView
				style={styles.body}
				keyboardShouldPersistTaps="handled"
				showsVerticalScrollIndicator={false}
			>
				{/* Access level */}
				<Text style={styles.fieldLabel}>Access</Text>
				<View style={styles.segment}>
					{["view", "edit"].map((lvl) => (
						<TouchableOpacity
							key={lvl}
							style={[
								styles.segmentBtn,
								accessLevel === lvl && styles.segmentBtnActive,
							]}
							onPress={() => setAccessLevel(lvl)}
						>
							<Text
								style={[
									styles.segmentText,
									accessLevel === lvl && styles.segmentTextActive,
								]}
							>
								{lvl === "view" ? "View" : "Edit"}
							</Text>
						</TouchableOpacity>
					))}
				</View>

				{/* Password */}
				<View style={styles.switchRow}>
					<Text style={styles.fieldLabel}>Password</Text>
					<TouchableOpacity
						style={[styles.switch, passwordEnabled && styles.switchOn]}
						onPress={() => {
							const next = !passwordEnabled;
							setPasswordEnabled(next);
							if (!next) setPassword("");
						}}
					>
						<View style={[styles.knob, passwordEnabled && styles.knobOn]} />
					</TouchableOpacity>
				</View>
				{passwordEnabled ? (
					<TextInput
						style={styles.input}
						placeholder="Enter password"
						placeholderTextColor={colors.muted}
						value={password}
						onChangeText={setPassword}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
					/>
				) : null}

				{/* Expiry */}
				<View style={styles.switchRow}>
					<Text style={styles.fieldLabel}>Expires</Text>
					<TouchableOpacity
						style={[styles.switch, expireEnabled && styles.switchOn]}
						onPress={() => setExpireEnabled((v) => !v)}
					>
						<View style={[styles.knob, expireEnabled && styles.knobOn]} />
					</TouchableOpacity>
				</View>
				{expireEnabled ? (
					<View style={styles.expiryWrap}>
						{EXPIRY_OPTIONS.map((opt) => (
							<TouchableOpacity
								key={opt.value}
								style={[
									styles.chip,
									expiresIn === opt.value && styles.chipActive,
								]}
								onPress={() => setExpiresIn(opt.value)}
							>
								<Text
									style={[
										styles.chipText,
										expiresIn === opt.value && styles.chipTextActive,
									]}
								>
									{opt.label}
								</Text>
							</TouchableOpacity>
						))}
					</View>
				) : null}

				<TouchableOpacity
					style={[styles.generateBtn, loading && { opacity: 0.6 }]}
					onPress={handleGenerate}
					disabled={loading}
				>
					<Ionicons
						name="share-social-outline"
						size={16}
						color={colors.bg}
					/>
					<Text style={styles.generateText}>
						{loading ? "..." : "Generate & share link"}
					</Text>
				</TouchableOpacity>

				{/* Active shares */}
				{shares.length > 0 ? (
					<View style={styles.activeWrap}>
						<Text style={styles.activeLabel}>Active shares</Text>
						{shares.map((share) => (
							<View key={share.id} style={styles.shareRow}>
								<Text
									style={[
										styles.accessTag,
										{
											color:
												share.access_level === "edit"
													? colors.accent3
													: colors.accent4,
										},
									]}
								>
									{share.access_level}
								</Text>
								<Text style={styles.slug} numberOfLines={1}>
									{share.slug}
								</Text>
								<Text style={styles.lock}>
									{share.has_password ? "🔒" : "🔓"}
								</Text>
								<Text style={styles.expiry}>
									{formatExpiry(share.expires_at)}
								</Text>
								<TouchableOpacity
									style={styles.rowBtn}
									onPress={() => handleShare(share, false)}
									hitSlop={6}
								>
									<Ionicons
										name="share-outline"
										size={16}
										color={colors.text}
									/>
								</TouchableOpacity>
								<TouchableOpacity
									style={styles.rowBtn}
									onPress={() => handleShare(share, true)}
									hitSlop={6}
								>
									<Text style={styles.aiIcon}>🤖</Text>
								</TouchableOpacity>
								<TouchableOpacity
									style={styles.rowBtn}
									onPress={() => handleRevoke(share.id)}
									hitSlop={6}
								>
									<Ionicons name="close" size={16} color={colors.accent3} />
								</TouchableOpacity>
							</View>
						))}
					</View>
				) : null}
			</ScrollView>
		</BottomSheet>
	);
}

const styles = StyleSheet.create({
	body: { maxHeight: SCREEN_H * 0.6 },
	fieldLabel: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
		marginBottom: 6,
	},
	segment: {
		flexDirection: "row",
		gap: 8,
		marginBottom: 14,
	},
	segmentBtn: {
		flex: 1,
		alignItems: "center",
		paddingVertical: 8,
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
	},
	segmentBtnActive: {
		backgroundColor: colors.bg,
		borderColor: colors.accent,
	},
	segmentText: { color: colors.muted, fontFamily: MONO, fontWeight: "700" },
	segmentTextActive: { color: colors.accent },
	switchRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: 8,
	},
	switch: {
		width: 44,
		height: 24,
		borderRadius: 12,
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		justifyContent: "center",
		paddingHorizontal: 2,
	},
	switchOn: { borderColor: colors.accent2 },
	knob: {
		width: 16,
		height: 16,
		borderRadius: 8,
		backgroundColor: colors.muted,
	},
	knobOn: { backgroundColor: colors.accent2, alignSelf: "flex-end" },
	input: {
		backgroundColor: colors.bg,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 10,
		paddingVertical: 8,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 13,
		marginBottom: 14,
	},
	expiryWrap: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
		marginBottom: 14,
	},
	chip: {
		paddingHorizontal: 10,
		paddingVertical: 6,
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
	},
	chipActive: { backgroundColor: colors.bg, borderColor: colors.accent },
	chipText: { color: colors.muted, fontFamily: MONO, fontSize: 12 },
	chipTextActive: { color: colors.accent, fontWeight: "700" },
	generateBtn: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		backgroundColor: colors.accent,
		paddingVertical: 12,
		marginTop: 4,
		boxShadow: "2px 2px 0 #000",
	},
	generateText: {
		color: colors.bg,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
	},
	activeWrap: { marginTop: 18 },
	activeLabel: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
		marginBottom: 6,
	},
	shareRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingVertical: 8,
		borderTopWidth: 1,
		borderTopColor: colors.border,
	},
	accessTag: {
		fontFamily: MONO,
		fontSize: 10,
		fontWeight: "700",
		textTransform: "uppercase",
	},
	slug: {
		flex: 1,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
	},
	lock: { fontSize: 12 },
	expiry: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 10,
		width: 36,
		textAlign: "right",
	},
	rowBtn: {
		width: 28,
		height: 28,
		alignItems: "center",
		justifyContent: "center",
	},
	aiIcon: { fontSize: 14 },
});
