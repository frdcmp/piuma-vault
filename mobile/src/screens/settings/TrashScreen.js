import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ConfirmModal from "../../components/ConfirmModal";
import SettingsHeader from "../../components/SettingsHeader";
import {
	useEmptyTrash,
	usePermanentlyDeleteNote,
	useRestoreNote,
	useTrash,
} from "../../queries/trashQuery";
import { timeAgo } from "../../utils/dateTime";
import { colors } from "../../utils/theme";

export default function TrashScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const { data, isLoading } = useTrash();
	const restore = useRestoreNote();
	const purge = usePermanentlyDeleteNote();
	const empty = useEmptyTrash();

	const [pendingPurge, setPendingPurge] = useState(null);
	const [emptyPrompt, setEmptyPrompt] = useState(false);

	const notes = data?.data || [];

	// `variables` holds the id passed to the last mutate() while it's in flight,
	// so we can show a spinner on exactly the row being purged/restored.
	const purgingId = purge.isPending ? purge.variables : null;
	const restoringId = restore.isPending ? restore.variables : null;

	const confirmPurge = () => {
		const note = pendingPurge;
		setPendingPurge(null);
		if (note) purge.mutate(note.id);
	};

	const confirmEmpty = () => {
		setEmptyPrompt(false);
		empty.mutate();
	};

	return (
		<View style={styles.root}>
			<SettingsHeader
				title="Trash"
				onBack={() => navigation.goBack()}
				right={
					empty.isPending ? (
						<ActivityIndicator size="small" color={colors.accent3} />
					) : (
						<Pressable
							onPress={() => setEmptyPrompt(true)}
							disabled={notes.length === 0}
							hitSlop={10}
						>
							<Ionicons
								name="trash"
								size={20}
								color={notes.length === 0 ? colors.muted : colors.accent3}
							/>
						</Pressable>
					)
				}
			/>
			{isLoading ? (
				<View style={styles.center}>
					<ActivityIndicator color={colors.accent} />
				</View>
			) : (
				<FlatList
					data={notes}
					keyExtractor={(item) => item.id}
					contentContainerStyle={[
						styles.list,
						{ paddingBottom: insets.bottom + 24 },
					]}
					ListHeaderComponent={
						<Text style={styles.intro}>
							Deleted notes are kept here until you restore them or empty the
							trash. Nothing is removed automatically.
						</Text>
					}
					ListEmptyComponent={<Text style={styles.empty}>Trash is empty.</Text>}
					renderItem={({ item }) => (
						<View style={styles.card}>
							<View style={styles.noteText}>
								<Text style={styles.title} numberOfLines={1}>
									{item.title || "Untitled"}
								</Text>
								<Text style={styles.meta} numberOfLines={1}>
									{item.folder || "/"} · deleted {timeAgo(item.deleted_at)}
								</Text>
							</View>
							<Pressable
								onPress={() => restore.mutate(item.id)}
								disabled={restoringId === item.id || purgingId === item.id}
								hitSlop={8}
								style={styles.action}
							>
								{restoringId === item.id ? (
									<ActivityIndicator size="small" color={colors.accent2} />
								) : (
									<Ionicons
										name="arrow-undo-outline"
										size={20}
										color={colors.accent2}
									/>
								)}
							</Pressable>
							<Pressable
								onPress={() => setPendingPurge(item)}
								disabled={restoringId === item.id || purgingId === item.id}
								hitSlop={8}
								style={styles.action}
							>
								{purgingId === item.id ? (
									<ActivityIndicator size="small" color={colors.accent3} />
								) : (
									<Ionicons
										name="trash-outline"
										size={20}
										color={colors.accent3}
									/>
								)}
							</Pressable>
						</View>
					)}
				/>
			)}

			<ConfirmModal
				visible={pendingPurge != null}
				title="Delete permanently"
				message={`Permanently delete "${pendingPurge?.title || "Untitled"}"? Its content and attachments will be removed for good. This cannot be undone.`}
				confirmText="Delete"
				onConfirm={confirmPurge}
				onCancel={() => setPendingPurge(null)}
			/>
			<ConfirmModal
				visible={emptyPrompt}
				title="Empty trash"
				message={`Permanently delete all ${notes.length} note(s) in the trash, including their attachments? This cannot be undone.`}
				confirmText="Empty trash"
				onConfirm={confirmEmpty}
				onCancel={() => setEmptyPrompt(false)}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	center: { flex: 1, alignItems: "center", justifyContent: "center" },
	list: { padding: 12, gap: 10 },
	intro: { color: colors.muted, fontSize: 13, marginBottom: 4 },
	empty: {
		color: colors.muted,
		fontSize: 14,
		textAlign: "center",
		padding: 24,
	},
	card: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		padding: 14,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 4,
	},
	noteText: { flex: 1 },
	title: { color: colors.text, fontSize: 15, fontWeight: "600" },
	meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
	action: { padding: 6 },
});
