import { Ionicons } from "@expo/vector-icons";
import {
	ActivityIndicator,
	FlatList,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import SettingsHeader from "../../components/SettingsHeader";
import { useSetActiveSprite, useSprites } from "../../queries/spritesQuery";
import { colors } from "../../utils/theme";

// Renders one pose of a sprite from its own definition + palette. Unlike the
// app-wide <Sprite>, this can't read the active palette from context (we're
// previewing every mascot), so it resolves colors from the passed definition.
function SpritePreview({ definition, pixelSize = 3 }) {
	const palette = definition?.palette || {};
	const rows = [...(definition?.body || []), ...(definition?.idleLegs || [])];
	return (
		<View>
			{rows.map((row, r) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static sprite rows never reorder
				<View key={`row-${r}`} style={styles.spriteRow}>
					{row.split("").map((code, c) => (
						<View
							// biome-ignore lint/suspicious/noArrayIndexKey: static sprite cells never reorder
							key={`px-${r}-${c}`}
							style={{
								width: pixelSize,
								height: pixelSize,
								backgroundColor: palette[code] || "transparent",
							}}
						/>
					))}
				</View>
			))}
		</View>
	);
}

export default function SpritePickerScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const { data, isLoading } = useSprites();
	const setActive = useSetActiveSprite();
	const sprites = data || [];

	// The key currently being activated — `variables` holds the last mutate()
	// argument while the request is in flight, so we can show a spinner on just
	// that card.
	const savingKey = setActive.isPending ? setActive.variables : null;

	const choose = (sprite) => {
		if (sprite.active || setActive.isPending) return;
		setActive.mutate(sprite.key);
	};

	return (
		<View style={styles.root}>
			<SettingsHeader
				title="Appearance"
				icon="color-palette-outline"
				onBack={() => navigation.goBack()}
			/>
			{isLoading ? (
				<View style={styles.center}>
					<ActivityIndicator color={colors.accent} />
				</View>
			) : (
				<FlatList
					data={sprites}
					keyExtractor={(item) => item.key}
					contentContainerStyle={[
						styles.list,
						{ paddingBottom: insets.bottom + 24 },
					]}
					ListHeaderComponent={
						<Text style={styles.intro}>
							Pick the mascot shown across the app. Create and edit custom
							sprites on the web.
						</Text>
					}
					ListEmptyComponent={
						<Text style={styles.empty}>No sprites found.</Text>
					}
					renderItem={({ item }) => {
						const saving = savingKey === item.key;
						return (
							<Pressable
								onPress={() => choose(item)}
								disabled={setActive.isPending}
								style={({ pressed }) => [
									styles.card,
									item.active && styles.cardActive,
									saving && styles.cardSaving,
									pressed && styles.cardPressed,
								]}
							>
								<View style={styles.preview}>
									<SpritePreview definition={item.definition} />
								</View>
								<View style={styles.cardText}>
									<Text style={styles.name}>{item.name}</Text>
									<Text style={styles.meta}>
										{item.is_builtin ? "Built-in" : "Custom"}
									</Text>
								</View>
								{saving ? (
									<ActivityIndicator color={colors.accent} />
								) : item.active ? (
									<View style={styles.activeTag}>
										<Ionicons
											name="checkmark-circle"
											size={18}
											color={colors.accent2}
										/>
										<Text style={styles.activeText}>Active</Text>
									</View>
								) : null}
							</Pressable>
						);
					}}
				/>
			)}
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
	spriteRow: { flexDirection: "row" },
	card: {
		flexDirection: "row",
		alignItems: "center",
		gap: 14,
		padding: 14,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 4,
	},
	cardActive: { borderColor: colors.accent2 },
	cardSaving: { borderColor: colors.accent, opacity: 0.7 },
	cardPressed: { backgroundColor: colors.bgSoft },
	preview: {
		width: 64,
		alignItems: "center",
		justifyContent: "center",
	},
	cardText: { flex: 1 },
	name: { color: colors.text, fontSize: 16, fontWeight: "600" },
	meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
	activeTag: { flexDirection: "row", alignItems: "center", gap: 4 },
	activeText: { color: colors.accent2, fontSize: 12 },
});
