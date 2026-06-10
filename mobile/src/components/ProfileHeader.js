import { StyleSheet, Text, View } from "react-native";
import { Sprite, useSprite } from "../sprites";
import { formatDate } from "../utils/dateTime";
import { colors, mono } from "../utils/theme";

// Pixel-style profile banner shown at the top of Settings. Greets the user by
// name beside the active mascot, with a couple of account tags. Hard square
// edges + monospace to match the vault's terminal/pixel aesthetic.
export default function ProfileHeader({ user }) {
	const { sprite } = useSprite();

	const fullName = [user?.first_name, user?.last_name]
		.filter(Boolean)
		.join(" ")
		.trim();
	const emailName = user?.email ? user.email.split("@")[0] : "vault";
	const name = fullName || emailName;

	return (
		<View style={styles.card}>
			<View style={styles.top}>
				<View style={styles.mascot}>
					<Sprite rows={sprite} pixelSize={3} />
				</View>
				<View style={styles.who}>
					<Text style={styles.kicker}>welcome back</Text>
					<Text style={styles.name} numberOfLines={1}>
						{name}
					</Text>
					{user?.email ? (
						<Text style={styles.email} numberOfLines={1}>
							{user.email}
						</Text>
					) : null}
				</View>
			</View>

			<View style={styles.tags}>
				{user?.created_at ? (
					<View style={styles.tag}>
						<Text style={styles.tagText}>
							since {formatDate(user.created_at)}
						</Text>
					</View>
				) : null}
				<View style={[styles.tag, user?.otp_enabled && styles.tagOn]}>
					<Text style={[styles.tagText, user?.otp_enabled && styles.tagTextOn]}>
						{user?.otp_enabled ? "2FA on" : "2FA off"}
					</Text>
				</View>
				{user?.is_verified ? (
					<View style={[styles.tag, styles.tagOn]}>
						<Text style={[styles.tagText, styles.tagTextOn]}>verified</Text>
					</View>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	card: {
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		padding: 16,
		gap: 14,
	},
	top: { flexDirection: "row", alignItems: "center", gap: 16 },
	mascot: {
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: colors.bg,
		padding: 8,
		alignItems: "center",
		justifyContent: "center",
	},
	who: { flex: 1 },
	kicker: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 11,
		textTransform: "uppercase",
		letterSpacing: 2,
	},
	name: {
		fontFamily: mono,
		color: colors.accent,
		fontSize: 22,
		fontWeight: "700",
		marginTop: 2,
	},
	email: {
		fontFamily: mono,
		color: colors.text,
		fontSize: 13,
		marginTop: 3,
	},
	tags: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	tag: {
		borderWidth: 2,
		borderColor: colors.border,
		paddingHorizontal: 8,
		paddingVertical: 3,
	},
	tagOn: { borderColor: colors.accent2 },
	tagText: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 11,
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	tagTextOn: { color: colors.accent2 },
});
