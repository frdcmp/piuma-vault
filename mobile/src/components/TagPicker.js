import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useTagRegistry } from "../queries/tagsQuery";
import { tagColor } from "../utils/tagColor";
import { colors, mono as MONO } from "../utils/theme";

/**
 * Tag editor for task/event sheets. Manages an array of tag names (`value`),
 * suggesting existing registry tags. New names are added lowercased — the
 * backend registers them uncategorized (Inbox) on save.
 */
export default function TagPicker({ value = [], onChange }) {
	const { data: registry = [] } = useTagRegistry();
	const [input, setInput] = useState("");

	const colorOf = (name) =>
		registry.find((r) => r.name === name)?.color || tagColor(name);

	const add = (raw) => {
		const name = raw.trim().toLowerCase();
		setInput("");
		if (!name || value.includes(name)) return;
		onChange?.([...value, name]);
	};
	const remove = (name) => onChange?.(value.filter((n) => n !== name));

	const q = input.trim().toLowerCase();
	const suggestions = registry
		.filter((r) => !value.includes(r.name) && (!q || r.name.includes(q)))
		.slice(0, 8);

	return (
		<View>
			{value.length ? (
				<View style={st.chips}>
					{value.map((name) => (
						<Pressable
							key={name}
							style={[st.chip, { borderColor: colorOf(name) }]}
							onPress={() => remove(name)}
							hitSlop={4}
						>
							<Text style={[st.chipText, { color: colorOf(name) }]}>
								#{name}
							</Text>
							<Ionicons name="close" size={12} color={colorOf(name)} />
						</Pressable>
					))}
				</View>
			) : null}
			<View style={st.inputRow}>
				<TextInput
					style={st.input}
					value={input}
					onChangeText={setInput}
					placeholder="add tag"
					placeholderTextColor={colors.muted}
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="done"
					blurOnSubmit={false}
					onSubmitEditing={() => add(input)}
				/>
				{input.trim() ? (
					<Pressable style={st.addBtn} onPress={() => add(input)}>
						<Text style={st.addBtnText}>add</Text>
					</Pressable>
				) : null}
			</View>
			{suggestions.length ? (
				<View style={st.suggest}>
					{suggestions.map((r) => (
						<Pressable
							key={r.id}
							style={st.sChip}
							onPress={() => add(r.name)}
							hitSlop={4}
						>
							<Text
								style={[st.sChipText, { color: r.color || tagColor(r.name) }]}
							>
								#{r.name}
							</Text>
						</Pressable>
					))}
				</View>
			) : null}
		</View>
	);
}

const st = StyleSheet.create({
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
	chip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		borderWidth: 1,
		paddingHorizontal: 8,
		paddingVertical: 4,
	},
	chipText: { fontFamily: MONO, fontSize: 12 },
	inputRow: { flexDirection: "row", gap: 6 },
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
	suggest: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
	sChip: {
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 8,
		paddingVertical: 4,
	},
	sChipText: { fontFamily: MONO, fontSize: 12 },
});
