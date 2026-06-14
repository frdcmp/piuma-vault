import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Linking,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ProfileHeader from "../components/ProfileHeader";
import SettingsHeader from "../components/SettingsHeader";
import { toast } from "../components/Toast";
import { CURRENT_VERSION, isNewer } from "../config/appUpdate";
import { useUserMe } from "../queries/userQuery";
import { openApkDownload, useAppUpdate } from "../query/useAppUpdate";
import { colors } from "../utils/theme";

// Admin link points at the web app's origin (the API URL without its "/api/v1"
// suffix) so it follows whatever backend the build targets.
const ADMIN_URL = `${(
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1"
).replace(/\/api\/v1\/?$/, "")}/admin`;

// Settings hub — greets the user (profile banner) then offers a sectioned menu
// that pushes the individual settings screens. A minimal mobile slice of the
// web admin: profile, appearance, trash and security.
const SECTIONS = [
	{
		route: "SettingsProfile",
		icon: "person-outline",
		label: "Profile",
		desc: "Your name and details",
	},
	{
		route: "SettingsAppearance",
		icon: "color-palette-outline",
		label: "Appearance",
		desc: "Choose the active mascot",
	},
	{
		route: "SettingsTrash",
		icon: "trash-outline",
		label: "Trash",
		desc: "Restore or purge deleted notes",
	},
	{
		route: "SettingsSecurity",
		icon: "lock-closed-outline",
		label: "Security",
		desc: "Screen lock & trusted devices",
	},
	{
		route: "SettingsMemory",
		icon: "sparkles-outline",
		label: "Memory",
		desc: "Agent memory & moderation",
	},
	{
		route: "Cron",
		icon: "time-outline",
		label: "Scheduled",
		desc: "Recurring agent jobs",
	},
	{
		route: "SettingsTokenUsage",
		icon: "stats-chart-outline",
		label: "Token usage",
		desc: "LLM spend & volume",
	},
	{
		url: ADMIN_URL,
		icon: "globe-outline",
		label: "Admin panel",
		desc: "Open the full web admin",
	},
];

export default function SettingsScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const { data: user } = useUserMe();
	// Manual update check — refetch the published manifest on tap and either offer
	// the download (Android, newer build) or confirm we're up to date.
	const { refetch: checkUpdate } = useAppUpdate({ enabled: false });
	const [checking, setChecking] = useState(false);
	const onCheckUpdate = async () => {
		if (checking) return;
		setChecking(true);
		try {
			const { data: latest } = await checkUpdate();
			if (latest && isNewer(latest.version, CURRENT_VERSION)) {
				Alert.alert(
					`Update available — v${latest.version}`,
					latest.notes ||
						`You're on v${CURRENT_VERSION}. A newer build is ready to download.`,
					[
						{ text: "Later", style: "cancel" },
						{
							text: "Download",
							onPress: () => openApkDownload(latest).catch(() => {}),
						},
					],
				);
			} else {
				Alert.alert(
					"Up to date",
					`You're on the latest version (v${CURRENT_VERSION}).`,
				);
			}
		} catch {
			toast.error("Couldn't check for updates");
		} finally {
			setChecking(false);
		}
	};
	return (
		<View style={styles.root}>
			<SettingsHeader
				title="Settings"
				icon="settings-outline"
				onBack={() => navigation.goBack()}
			/>
			<ScrollView
				contentContainerStyle={[
					styles.list,
					{ paddingBottom: insets.bottom + 24 },
				]}
			>
				<Pressable onPress={() => navigation.navigate("SettingsProfile")}>
					<ProfileHeader user={user} />
				</Pressable>
				{SECTIONS.map((s) => (
					<Pressable
						key={s.route || s.url}
						onPress={() =>
							s.url ? Linking.openURL(s.url) : navigation.navigate(s.route)
						}
						style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
					>
						<Ionicons name={s.icon} size={22} color={colors.accent} />
						<View style={styles.rowText}>
							<Text style={styles.rowLabel}>{s.label}</Text>
							<Text style={styles.rowDesc}>{s.desc}</Text>
						</View>
						<Ionicons
							name={s.url ? "open-outline" : "chevron-forward"}
							size={18}
							color={colors.muted}
						/>
					</Pressable>
				))}

				{/* App version — tap to manually check for a newer build. */}
				<Pressable
					onPress={onCheckUpdate}
					disabled={checking}
					style={({ pressed }) => [
						styles.version,
						pressed && styles.rowPressed,
					]}
				>
					<Text style={styles.versionText}>
						pv vault · v{CURRENT_VERSION}
					</Text>
					<View style={styles.versionHint}>
						{checking ? (
							<ActivityIndicator size="small" color={colors.muted} />
						) : (
							<Ionicons name="refresh" size={13} color={colors.muted} />
						)}
						<Text style={styles.versionHintText}>
							{checking ? "checking…" : "tap to check for updates"}
						</Text>
					</View>
				</Pressable>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	list: { padding: 12, gap: 10 },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 14,
		padding: 16,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 4,
	},
	rowPressed: { backgroundColor: colors.bgSoft },
	rowText: { flex: 1 },
	rowLabel: { color: colors.text, fontSize: 16, fontWeight: "600" },
	rowDesc: { color: colors.muted, fontSize: 13, marginTop: 2 },
	version: { alignItems: "center", paddingVertical: 18, gap: 4 },
	versionText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
	versionHint: { flexDirection: "row", alignItems: "center", gap: 5 },
	versionHintText: { color: colors.muted, fontSize: 11 },
});
