import {
	ActivityIndicator,
	Modal,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { colors, mono } from "../utils/theme";

// Centered confirm dialog in the pv pixel style — hard square edges, mono
// type, accent title. Cancel + (danger) confirm; tapping the scrim cancels.
// While `loading` is true the confirm shows a spinner and both actions + the
// scrim are locked, so the dialog stays up until the async work settles.
export default function ConfirmModal({
	visible,
	title,
	message,
	confirmText = "Confirm",
	danger = true,
	loading = false,
	onConfirm,
	onCancel,
}) {
	const dismiss = loading ? undefined : onCancel;
	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={dismiss}
		>
			<Pressable style={styles.overlay} onPress={dismiss}>
				<Pressable style={styles.card} onPress={() => {}}>
					<Text style={styles.title}>{title}</Text>
					{message ? <Text style={styles.message}>{message}</Text> : null}
					<View style={styles.actions}>
						<Pressable
							onPress={dismiss}
							disabled={loading}
							style={({ pressed }) => [
								styles.btn,
								pressed && styles.btnPressed,
								loading && styles.btnMuted,
							]}
						>
							<Text style={styles.btnText}>Cancel</Text>
						</Pressable>
						<Pressable
							onPress={loading ? undefined : onConfirm}
							disabled={loading}
							style={({ pressed }) => [
								styles.btn,
								danger && styles.btnDanger,
								pressed && styles.btnPressed,
							]}
						>
							{loading ? (
								<ActivityIndicator
									size="small"
									color={danger ? colors.accent3 : colors.accent}
								/>
							) : (
								<Text style={[styles.btnText, danger && styles.btnTextDanger]}>
									{confirmText}
								</Text>
							)}
						</Pressable>
					</View>
				</Pressable>
			</Pressable>
		</Modal>
	);
}

const styles = StyleSheet.create({
	overlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		padding: 24,
	},
	card: {
		width: "100%",
		maxWidth: 360,
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		padding: 18,
	},
	title: {
		color: colors.accent,
		fontFamily: mono,
		fontSize: 16,
		fontWeight: "700",
	},
	message: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 12,
		marginTop: 8,
		lineHeight: 19,
	},
	actions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		gap: 8,
		marginTop: 18,
	},
	btn: {
		minWidth: 84,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 14,
		paddingVertical: 9,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	btnPressed: { opacity: 0.55 },
	btnMuted: { opacity: 0.4 },
	btnDanger: { borderColor: colors.accent3 },
	btnText: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 12,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	btnTextDanger: { color: colors.accent3 },
});
