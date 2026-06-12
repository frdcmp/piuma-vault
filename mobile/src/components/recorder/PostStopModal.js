import { useState } from "react";
import {
	ActivityIndicator,
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { colors, mono } from "../../utils/theme";

// Shown after a recording stops (session is 'ready' — transcript saved, no note
// yet). The user chooses what to do, mirroring the web post-stop modal:
//   • Summarize now     → create/refresh the vault note
//   • Append to another → merge this transcript into an existing recording
//   • Keep transcript   → leave it as-is, summarise/append later
// While `busy` (a label string) is set, the modal locks and shows a loader.

export default function PostStopModal({
	visible,
	busy,
	appendTargets = [],
	onSummarise,
	onAppend,
	onKeep,
	onClose,
}) {
	const [picking, setPicking] = useState(false);
	const locked = !!busy;
	const dismiss = locked ? undefined : onClose;

	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={dismiss}
		>
			<Pressable style={styles.overlay} onPress={dismiss}>
				<Pressable style={styles.card} onPress={() => {}}>
					<Text style={styles.title}>recording stopped</Text>

					{busy ? (
						<View style={styles.busy}>
							<ActivityIndicator color={colors.accent} />
							<Text style={styles.busyText}>{busy}</Text>
						</View>
					) : picking ? (
						<>
							<Text style={styles.message}>Append this transcript onto…</Text>
							<ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
								{appendTargets.map((r) => (
									<Pressable
										key={r.id}
										onPress={() => onAppend(r.id)}
										style={({ pressed }) => [
											styles.target,
											pressed && styles.btnPressed,
										]}
									>
										<Text style={styles.targetTitle} numberOfLines={1}>
											{r.title || "Untitled recording"}
										</Text>
										<Text style={styles.targetMeta}>
											{r.status === "done" ? "summarized · " : ""}
											{r.word_count > 0 ? `${r.word_count} words` : "—"}
										</Text>
									</Pressable>
								))}
							</ScrollView>
							<Pressable
								onPress={() => setPicking(false)}
								style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
							>
								<Text style={styles.btnText}>← Back</Text>
							</Pressable>
						</>
					) : (
						<>
							<Text style={styles.message}>
								Transcript saved. What do you want to do?
							</Text>
							<Pressable
								onPress={onSummarise}
								style={({ pressed }) => [
									styles.btn,
									styles.btnPrimary,
									pressed && styles.btnPressed,
								]}
							>
								<Text style={[styles.btnText, styles.btnTextPrimary]}>
									Summarize now
								</Text>
							</Pressable>
							<Pressable
								disabled={appendTargets.length === 0}
								onPress={() => setPicking(true)}
								style={({ pressed }) => [
									styles.btn,
									pressed && styles.btnPressed,
									appendTargets.length === 0 && styles.btnMuted,
								]}
							>
								<Text style={styles.btnText}>Append to another…</Text>
							</Pressable>
							<Pressable
								onPress={onKeep}
								style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
							>
								<Text style={styles.btnText}>Keep transcript only</Text>
							</Pressable>
							<Text style={styles.hint}>
								“Keep” stores the transcript without a summary — summarize or
								append later from its page.
							</Text>
						</>
					)}
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
		maxWidth: 380,
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		padding: 18,
		gap: 10,
	},
	title: {
		color: colors.accent,
		fontFamily: mono,
		fontSize: 16,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	message: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 12,
		lineHeight: 19,
	},
	hint: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 10,
		lineHeight: 16,
		opacity: 0.8,
		marginTop: 2,
	},
	busy: {
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		paddingVertical: 22,
	},
	busyText: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 12,
		textAlign: "center",
	},
	list: { maxHeight: 220 },
	btn: {
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 14,
		paddingVertical: 11,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	btnPrimary: { borderColor: colors.accent, backgroundColor: colors.accent },
	btnMuted: { opacity: 0.4 },
	btnPressed: { opacity: 0.55 },
	btnText: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 12,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	btnTextPrimary: { color: colors.bg },
	target: {
		paddingHorizontal: 12,
		paddingVertical: 10,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		marginBottom: 6,
	},
	targetTitle: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 13,
		fontWeight: "700",
	},
	targetMeta: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 10,
		marginTop: 3,
	},
});
