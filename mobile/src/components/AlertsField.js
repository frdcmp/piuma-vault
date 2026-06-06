import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors } from "../utils/theme";

// Preset reminder offsets (minutes before the anchor). 0 = fire exactly at start.
const PRESETS = [
	{ minutes: 0, label: "At start" },
	{ minutes: 10, label: "10m" },
	{ minutes: 30, label: "30m" },
	{ minutes: 60, label: "1h" },
	{ minutes: 1440, label: "1d" },
];

const UNITS = [
	{ value: "minutes", label: "min", factor: 1 },
	{ value: "hours", label: "hr", factor: 60 },
	{ value: "days", label: "day", factor: 1440 },
];

export function formatOffset(mins) {
	if (mins <= 0) return "At start";
	if (mins % 1440 === 0) {
		const d = mins / 1440;
		return `${d} day${d === 1 ? "" : "s"} before`;
	}
	if (mins % 60 === 0) {
		const h = mins / 60;
		return `${h} hour${h === 1 ? "" : "s"} before`;
	}
	return `${mins} min before`;
}

/**
 * Alerts editor for the mobile sheets — a list of reminder offsets (minutes
 * before the event/task anchor). `value` is the alerts array
 * (`[{ offset_minutes, channels? }]`); `onChange` receives the next array.
 */
export default function AlertsField({ value = [], onChange }) {
	const [customN, setCustomN] = useState("15");
	const [unitIdx, setUnitIdx] = useState(0);

	// `alerts` is a free-form JSON column on the backend (defaults to an array,
	// but legacy rows may hold an object/null), so coerce to an array before use.
	const list = Array.isArray(value) ? value : [];
	const offsets = new Set(list.map((a) => a.offset_minutes));
	const sorted = [...list].sort((a, b) => a.offset_minutes - b.offset_minutes);

	const addOffset = (mins) => {
		if (offsets.has(mins)) return;
		onChange([...list, { offset_minutes: mins }]);
	};
	const removeOffset = (mins) =>
		onChange(list.filter((a) => a.offset_minutes !== mins));
	const toggleOffset = (mins) =>
		offsets.has(mins) ? removeOffset(mins) : addOffset(mins);

	const addCustom = () => {
		const factor = UNITS[unitIdx].factor;
		const mins = Math.max(0, Math.round(Number(customN) * factor));
		if (Number.isNaN(mins)) return;
		addOffset(mins);
	};

	return (
		<View style={s.wrap}>
			<View style={s.row}>
				{PRESETS.map((p) => {
					const on = offsets.has(p.minutes);
					return (
						<Pressable
							key={p.minutes}
							style={[s.chip, on && s.chipOn]}
							onPress={() => toggleOffset(p.minutes)}
						>
							<Text style={[s.chipText, on && s.chipTextOn]}>{p.label}</Text>
						</Pressable>
					);
				})}
			</View>

			<View style={s.customRow}>
				<TextInput
					style={s.customInput}
					value={customN}
					onChangeText={setCustomN}
					keyboardType="number-pad"
					placeholderTextColor={colors.muted}
				/>
				<Pressable
					style={s.unitBtn}
					onPress={() => setUnitIdx((i) => (i + 1) % UNITS.length)}
				>
					<Text style={s.chipText}>{UNITS[unitIdx].label}</Text>
				</Pressable>
				<Pressable style={s.addBtn} onPress={addCustom}>
					<Text style={s.chipText}>+ Add</Text>
				</Pressable>
			</View>

			{sorted.length ? (
				<View style={s.tagWrap}>
					{sorted.map((a) => (
						<Pressable
							key={a.offset_minutes}
							style={s.tag}
							onPress={() => removeOffset(a.offset_minutes)}
						>
							<Text style={s.tagText}>
								🔔 {formatOffset(a.offset_minutes)} ✕
							</Text>
						</Pressable>
					))}
				</View>
			) : (
				<Text style={s.empty}>No alerts</Text>
			)}
		</View>
	);
}

const s = StyleSheet.create({
	wrap: { gap: 8 },
	row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
	chip: {
		paddingVertical: 4,
		paddingHorizontal: 10,
		borderRadius: 6,
		borderWidth: 1,
		borderColor: colors.border,
	},
	chipOn: { backgroundColor: colors.accent4, borderColor: colors.accent4 },
	chipText: { color: colors.text, fontSize: 13 },
	chipTextOn: { color: "#0b0b0b", fontWeight: "600" },
	customRow: { flexDirection: "row", alignItems: "center", gap: 6 },
	customInput: {
		width: 64,
		color: colors.text,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 6,
		paddingVertical: 4,
		paddingHorizontal: 8,
	},
	unitBtn: {
		paddingVertical: 4,
		paddingHorizontal: 10,
		borderRadius: 6,
		borderWidth: 1,
		borderColor: colors.border,
	},
	addBtn: {
		paddingVertical: 4,
		paddingHorizontal: 10,
		borderRadius: 6,
		borderWidth: 1,
		borderColor: colors.borderStrong,
	},
	tagWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
	tag: {
		paddingVertical: 3,
		paddingHorizontal: 8,
		borderRadius: 6,
		borderWidth: 1,
		borderColor: colors.border,
	},
	tagText: { color: colors.text, fontSize: 12 },
	empty: { color: colors.muted, fontSize: 12 },
});
