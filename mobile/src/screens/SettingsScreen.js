import { Ionicons } from "@expo/vector-icons";
import {
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
import { useUserMe } from "../queries/userQuery";
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
	return (
		<View style={styles.root}>
			<SettingsHeader title="Settings" onBack={() => navigation.goBack()} />
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
});
