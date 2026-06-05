import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import {
	useBuckets,
	useCreateBucket,
	useDeleteBucket,
	useDeleteTag,
	useTagRegistry,
	useUpdateBucket,
} from "../queries/tagsQuery";
import { tagColor } from "../utils/tagColor";
import { colors, mono as MONO } from "../utils/theme";
import BottomSheet from "./BottomSheet";

/**
 * Manage buckets & tags. Buckets are task groups: add/rename/delete them. Tags
 * are flat labels: rename (web) / delete here. Shared by Tasks and Calendar.
 */
export default function ManageBucketsSheet({ onClose }) {
	const { data: buckets = [] } = useBuckets();
	const { data: tags = [] } = useTagRegistry();
	const createBucket = useCreateBucket();
	const updateBucket = useUpdateBucket();
	const deleteBucket = useDeleteBucket();
	const deleteTag = useDeleteTag();
	const [newBucket, setNewBucket] = useState("");

	const addBucket = () => {
		const name = newBucket.trim();
		if (!name) return;
		createBucket.mutate({ name }, { onSuccess: () => setNewBucket("") });
	};

	const renameBucket = (b, value) => {
		const name = value.trim();
		if (!name || name === b.name) return;
		updateBucket.mutate({ id: b.id, name });
	};

	return (
		<BottomSheet visible onClose={onClose} title="Buckets & tags">
			<ScrollView
				style={st.scroll}
				keyboardShouldPersistTaps="handled"
				showsVerticalScrollIndicator={false}
			>
				<Text style={st.section}>BUCKETS</Text>
				<View style={st.addRow}>
					<TextInput
						style={st.input}
						value={newBucket}
						onChangeText={setNewBucket}
						placeholder="New bucket name"
						placeholderTextColor={colors.muted}
						returnKeyType="done"
						onSubmitEditing={addBucket}
					/>
					<Pressable style={st.addBtn} onPress={addBucket}>
						<Text style={st.addBtnText}>+ add</Text>
					</Pressable>
				</View>
				{buckets.map((b) => (
					<View key={b.id} style={st.row}>
						<View
							style={[st.dot, { backgroundColor: b.color || colors.accent2 }]}
						/>
						<TextInput
							style={st.rowName}
							defaultValue={b.name}
							onBlur={(e) => renameBucket(b, e.nativeEvent.text)}
							placeholderTextColor={colors.muted}
						/>
						<Pressable onPress={() => deleteBucket.mutate(b.id)} hitSlop={8}>
							<Ionicons name="trash-outline" size={16} color={colors.muted} />
						</Pressable>
					</View>
				))}
				{buckets.length === 0 ? (
					<Text style={st.empty}>No buckets yet.</Text>
				) : null}

				<Text style={st.section}>TAGS</Text>
				{tags.map((t) => (
					<View key={t.id} style={st.row}>
						<View
							style={[st.dot, { backgroundColor: t.color || tagColor(t.name) }]}
						/>
						<Text style={st.tagName}>#{t.name}</Text>
						<Pressable onPress={() => deleteTag.mutate(t.id)} hitSlop={8}>
							<Ionicons name="trash-outline" size={16} color={colors.muted} />
						</Pressable>
					</View>
				))}
				{tags.length === 0 ? <Text style={st.empty}>No tags yet.</Text> : null}
				<Text style={st.hint}>
					Buckets group tasks; tags are flat labels independent of buckets.
					Deleting a bucket drops its tasks to no bucket.
				</Text>
			</ScrollView>
		</BottomSheet>
	);
}

const st = StyleSheet.create({
	scroll: { maxHeight: 460 },
	section: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1.5,
		marginTop: 14,
		marginBottom: 8,
	},
	addRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
	input: {
		flex: 1,
		backgroundColor: colors.bg,
		borderWidth: 1,
		borderColor: colors.border,
		color: colors.text,
		fontFamily: MONO,
		paddingHorizontal: 10,
		paddingVertical: 7,
		fontSize: 14,
	},
	addBtn: {
		borderWidth: 1,
		borderColor: colors.accent2,
		paddingHorizontal: 12,
		justifyContent: "center",
	},
	addBtnText: { color: colors.accent2, fontFamily: MONO, fontSize: 12 },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingVertical: 6,
	},
	dot: { width: 12, height: 12, borderRadius: 6 },
	rowName: {
		flex: 1,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		paddingVertical: 2,
	},
	tagBlock: {
		borderTopWidth: 1,
		borderTopColor: colors.border,
		paddingBottom: 4,
	},
	tagName: { flex: 1, color: colors.text, fontFamily: MONO, fontSize: 14 },
	bucketChips: { flexDirection: "row", gap: 6, paddingBottom: 6 },
	bChip: {
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 9,
		paddingVertical: 4,
	},
	bChipOn: { borderColor: colors.accent2, backgroundColor: colors.bg },
	bChipText: { color: colors.muted, fontFamily: MONO, fontSize: 12 },
	bChipTextOn: { color: colors.accent2 },
	empty: {
		color: colors.muted,
		fontFamily: MONO,
		fontStyle: "italic",
		fontSize: 12,
		paddingVertical: 4,
	},
	hint: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		lineHeight: 16,
		marginTop: 12,
		marginBottom: 4,
	},
});
