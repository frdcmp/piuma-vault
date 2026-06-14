import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSprite } from "../sprites";
import { usePrefsStore } from "../stores/prefsStore";
import { colors, mono } from "../utils/theme";
import { getHomeMenu } from "./home";
import { buildHomeItems } from "./home/menuItems";
import PixelStarfield from "./PixelStarfield";
import { BottomBar } from "./SystemBars";

// Home-screen shell. Owns the shared chrome (starfield, logout confirmation)
// and delegates the actual menu rendering to the layout the user picked. The
// layout switcher itself lives in the header (VaultHomeScreen); tapping the
// mascot reveals it via onMascotTap. Each layout receives the same destination
// list + mascot name + dims.
export default function HomeMenu({
	onFiles,
	onChat,
	onStorage,
	onTasks,
	onCalendar,
	onRecorder,
	onSettings,
	onLogout,
	onMascotTap,
}) {
	const { name } = useSprite();
	const menuStyle = usePrefsStore((s) => s.menuStyle);
	const [dims, setDims] = useState({ width: 0, height: 0 });
	const [confirmLogout, setConfirmLogout] = useState(false);

	const items = buildHomeItems({
		onFiles,
		onChat,
		onStorage,
		onTasks,
		onCalendar,
		onRecorder,
		onSettings,
		onLogout: () => setConfirmLogout(true),
	});

	const { Component } = getHomeMenu(menuStyle);

	return (
		<View
			style={styles.container}
			onLayout={(e) => setDims(e.nativeEvent.layout)}
		>
			{dims.width > 0 && (
				<PixelStarfield width={dims.width} height={dims.height} />
			)}

			<Component
				items={items}
				name={name}
				dims={dims}
				onMascotTap={onMascotTap}
			/>

			{/* Logout confirmation */}
			<Modal
				visible={confirmLogout}
				transparent
				animationType="fade"
				onRequestClose={() => setConfirmLogout(false)}
			>
				<Pressable
					style={styles.confirmOverlay}
					onPress={() => setConfirmLogout(false)}
				>
					<Pressable style={styles.confirmCard} onPress={() => {}}>
						<Text style={styles.confirmTitle}>Log out?</Text>
						<Text style={styles.confirmHint}>
							{name} will miss you. You'll need to sign back in.
						</Text>
						<View style={styles.confirmActions}>
							<Pressable
								style={({ pressed }) => [
									styles.confirmBtn,
									pressed && styles.confirmBtnPressed,
								]}
								onPress={() => setConfirmLogout(false)}
							>
								<Text style={styles.confirmBtnText}>Cancel</Text>
							</Pressable>
							<Pressable
								style={({ pressed }) => [
									styles.confirmBtn,
									styles.confirmBtnDanger,
									pressed && styles.confirmBtnPressed,
								]}
								onPress={() => {
									setConfirmLogout(false);
									onLogout?.();
								}}
							>
								<Text
									style={[styles.confirmBtnText, styles.confirmBtnTextDanger]}
								>
									Log out
								</Text>
							</Pressable>
						</View>
					</Pressable>
				</Pressable>
				<BottomBar />
			</Modal>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: colors.bg,
	},
	confirmOverlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 28,
	},
	confirmCard: {
		width: "100%",
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		borderStyle: "dashed",
		padding: 18,
	},
	confirmTitle: {
		color: colors.accent,
		fontFamily: mono,
		fontSize: 16,
		fontWeight: "700",
	},
	confirmHint: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 11,
		marginTop: 4,
		marginBottom: 12,
	},
	confirmActions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		gap: 8,
		marginTop: 8,
	},
	confirmBtn: {
		paddingHorizontal: 14,
		paddingVertical: 8,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	confirmBtnPressed: { opacity: 0.45 },
	confirmBtnDanger: { borderColor: colors.accent3 },
	confirmBtnText: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 12,
		fontWeight: "700",
	},
	confirmBtnTextDanger: { color: colors.accent3 },
});
