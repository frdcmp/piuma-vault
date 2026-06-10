import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../utils/theme";

// Centered confirm dialog with a Cancel + (danger) confirm action. Tapping the
// scrim cancels. Shared by the destructive settings flows.
export default function ConfirmModal({
	visible,
	title,
	message,
	confirmText = "Confirm",
	danger = true,
	onConfirm,
	onCancel,
}) {
	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={onCancel}
		>
			<Pressable style={styles.overlay} onPress={onCancel}>
				<Pressable style={styles.card} onPress={() => {}}>
					<Text style={styles.title}>{title}</Text>
					{message ? <Text style={styles.message}>{message}</Text> : null}
					<View style={styles.actions}>
						<Pressable
							onPress={onCancel}
							style={({ pressed }) => [
								styles.btn,
								pressed && styles.btnPressed,
							]}
						>
							<Text style={styles.btnText}>Cancel</Text>
						</Pressable>
						<Pressable
							onPress={onConfirm}
							style={({ pressed }) => [
								styles.btn,
								danger && styles.btnDanger,
								pressed && styles.btnPressed,
							]}
						>
							<Text style={[styles.btnText, danger && styles.btnTextDanger]}>
								{confirmText}
							</Text>
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
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 6,
		padding: 20,
	},
	title: { color: colors.text, fontSize: 17, fontWeight: "700" },
	message: { color: colors.muted, fontSize: 14, marginTop: 10, lineHeight: 20 },
	actions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		gap: 10,
		marginTop: 20,
	},
	btn: {
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 4,
		borderWidth: 1,
		borderColor: colors.border,
	},
	btnPressed: { backgroundColor: colors.bgSoft },
	btnDanger: { borderColor: colors.accent3 },
	btnText: { color: colors.text, fontSize: 14, fontWeight: "600" },
	btnTextDanger: { color: colors.accent3 },
});
