import dayjs from "dayjs";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatDate, formatTime } from "../utils/dateTime";
import { colors, mono as MONO } from "../utils/theme";
import BottomSheet from "./BottomSheet";

const WEEKDAYS = [
	{ id: "su", label: "S" },
	{ id: "mo", label: "M" },
	{ id: "tu", label: "T" },
	{ id: "we", label: "W" },
	{ id: "th", label: "T" },
	{ id: "fr", label: "F" },
	{ id: "sa", label: "S" },
];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

/**
 * Themed date/time selector for React Native. Mirrors the web
 * PvDateTimePicker: works in the device LOCAL timezone but accepts and
 * emits UTC ISO strings.
 *
 * Props: value (UTC ISO|null), onChange(utcIsoOrNull), mode
 * ("datetime"|"date"|"time"), placeholder, clearable.
 */
export default function DateTimePickerField({
	value,
	onChange,
	mode = "datetime",
	placeholder = "Pick…",
	clearable = true,
}) {
	const showDate = mode === "datetime" || mode === "date";
	const showTime = mode === "datetime" || mode === "time";

	const [open, setOpen] = useState(false);
	const selected = useMemo(() => (value ? dayjs(value) : null), [value]);
	const [viewMonth, setViewMonth] = useState(() =>
		(selected || dayjs()).startOf("month"),
	);

	const emit = (next) => onChange?.(next ? next.toISOString() : null);

	const pickDay = (day) => {
		const base = selected || dayjs().hour(9).minute(0);
		const next = day
			.hour(showTime ? base.hour() : 0)
			.minute(showTime ? base.minute() : 0)
			.second(0);
		emit(next);
		if (mode === "date") setOpen(false);
	};
	const pickHour = (h) =>
		emit((selected || dayjs().minute(0)).hour(h).second(0));
	const pickMinute = (m) => emit((selected || dayjs()).minute(m).second(0));

	const label = (() => {
		if (!selected) return placeholder;
		if (mode === "date") return formatDate(value);
		if (mode === "time") return formatTime(value);
		return `${formatDate(value)} · ${formatTime(value)}`;
	})();

	const weeks = useMemo(() => {
		const start = viewMonth.startOf("month").startOf("week");
		const out = [];
		let d = start;
		for (let w = 0; w < 6; w++) {
			const row = [];
			for (let i = 0; i < 7; i++) {
				row.push(d);
				d = d.add(1, "day");
			}
			out.push(row);
		}
		return out;
	}, [viewMonth]);

	const todayKey = dayjs().format("YYYY-MM-DD");
	const selKey = selected?.format("YYYY-MM-DD");

	return (
		<>
			<Pressable
				style={[s.field, !selected && s.fieldEmpty]}
				onPress={() => setOpen(true)}
			>
				<Text style={[s.fieldText, !selected && s.fieldPlaceholder]}>
					{label}
				</Text>
				<Text style={s.fieldGlyph}>{mode === "time" ? "🕘" : "▤"}</Text>
			</Pressable>

			<BottomSheet
				visible={open}
				onClose={() => setOpen(false)}
				title={mode === "time" ? "Pick time" : "Pick date"}
			>
				<View style={s.body}>
					{showDate ? (
						<View>
							<View style={s.calHead}>
								<Pressable
									onPress={() => setViewMonth((m) => m.subtract(1, "month"))}
									hitSlop={10}
								>
									<Text style={s.nav}>‹</Text>
								</Pressable>
								<Text style={s.month}>{viewMonth.format("MMMM YYYY")}</Text>
								<Pressable
									onPress={() => setViewMonth((m) => m.add(1, "month"))}
									hitSlop={10}
								>
									<Text style={s.nav}>›</Text>
								</Pressable>
							</View>
							<View style={s.row}>
								{WEEKDAYS.map((w) => (
									<Text key={w.id} style={s.weekday}>
										{w.label}
									</Text>
								))}
							</View>
							{weeks.map((wk) => (
								<View key={wk[0].format("YYYY-MM-DD")} style={s.row}>
									{wk.map((day) => {
										const k = day.format("YYYY-MM-DD");
										const other = day.month() !== viewMonth.month();
										const isSel = k === selKey;
										const isToday = k === todayKey;
										return (
											<Pressable
												key={k}
												style={[s.day, isSel && s.daySel]}
												onPress={() => pickDay(day)}
											>
												<Text
													style={[
														s.dayText,
														other && s.dayOther,
														isToday && s.dayToday,
														isSel && s.dayTextSel,
													]}
												>
													{day.date()}
												</Text>
											</Pressable>
										);
									})}
								</View>
							))}
						</View>
					) : null}

					{showTime ? (
						<View style={s.timeWrap}>
							<ScrollView
								style={s.timeCol}
								contentContainerStyle={s.timeColInner}
							>
								{HOURS.map((h) => {
									const on = selected?.hour() === h;
									return (
										<Pressable
											key={h}
											style={[s.timeItem, on && s.timeItemOn]}
											onPress={() => pickHour(h)}
										>
											<Text style={[s.timeText, on && s.timeTextOn]}>
												{String(h).padStart(2, "0")}
											</Text>
										</Pressable>
									);
								})}
							</ScrollView>
							<Text style={s.timeSep}>:</Text>
							<ScrollView
								style={s.timeCol}
								contentContainerStyle={s.timeColInner}
							>
								{MINUTES.map((m) => {
									const on =
										selected && Math.floor(selected.minute() / 5) * 5 === m;
									return (
										<Pressable
											key={m}
											style={[s.timeItem, on && s.timeItemOn]}
											onPress={() => pickMinute(m)}
										>
											<Text style={[s.timeText, on && s.timeTextOn]}>
												{String(m).padStart(2, "0")}
											</Text>
										</Pressable>
									);
								})}
							</ScrollView>
						</View>
					) : null}

					<View style={s.foot}>
						{clearable ? (
							<Pressable
								onPress={() => {
									emit(null);
									setOpen(false);
								}}
							>
								<Text style={s.action}>Clear</Text>
							</Pressable>
						) : (
							<View />
						)}
						<Pressable
							onPress={() => {
								emit(dayjs());
								setViewMonth(dayjs().startOf("month"));
							}}
						>
							<Text style={s.action}>Now</Text>
						</Pressable>
						<Pressable onPress={() => setOpen(false)}>
							<Text style={[s.action, s.actionDone]}>Done</Text>
						</Pressable>
					</View>
				</View>
			</BottomSheet>
		</>
	);
}

const s = StyleSheet.create({
	field: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		backgroundColor: colors.bg,
		borderWidth: 1,
		borderColor: colors.border,
		paddingHorizontal: 10,
		paddingVertical: 9,
	},
	fieldEmpty: {},
	fieldText: { color: colors.text, fontFamily: MONO, fontSize: 14 },
	fieldPlaceholder: { color: colors.muted },
	fieldGlyph: { color: colors.accent, fontFamily: MONO, fontSize: 14 },
	body: { paddingHorizontal: 16, paddingTop: 4 },
	calHead: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: 8,
	},
	nav: { color: colors.text, fontFamily: MONO, fontSize: 22, paddingHorizontal: 10 },
	month: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
		letterSpacing: 0.5,
		textTransform: "uppercase",
	},
	row: { flexDirection: "row" },
	weekday: {
		flex: 1,
		textAlign: "center",
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		paddingVertical: 4,
	},
	day: {
		flex: 1,
		aspectRatio: 1,
		alignItems: "center",
		justifyContent: "center",
	},
	daySel: { backgroundColor: colors.accent },
	dayText: { color: colors.text, fontFamily: MONO, fontSize: 13 },
	dayOther: { color: colors.muted, opacity: 0.5 },
	dayToday: { color: colors.accent4, fontWeight: "700" },
	dayTextSel: { color: "#000", fontWeight: "700" },
	timeWrap: {
		flexDirection: "row",
		justifyContent: "center",
		alignItems: "stretch",
		marginTop: 12,
		gap: 6,
	},
	timeCol: { maxHeight: 168, width: 64 },
	timeColInner: { gap: 4, paddingVertical: 2 },
	timeItem: {
		borderWidth: 1,
		borderColor: colors.border,
		paddingVertical: 6,
		alignItems: "center",
		backgroundColor: colors.bg,
	},
	timeItemOn: { backgroundColor: colors.accent, borderColor: colors.accent },
	timeText: { color: colors.text, fontFamily: MONO, fontSize: 14 },
	timeTextOn: { color: "#000", fontWeight: "700" },
	timeSep: {
		color: colors.muted,
		fontFamily: MONO,
		alignSelf: "center",
		fontSize: 16,
	},
	foot: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		borderTopWidth: 1,
		borderTopColor: colors.border,
		marginTop: 12,
		paddingTop: 10,
	},
	action: {
		color: colors.accent4,
		fontFamily: MONO,
		fontSize: 13,
		fontWeight: "700",
		letterSpacing: 0.5,
		textTransform: "uppercase",
		paddingVertical: 2,
	},
	actionDone: { color: colors.accent2 },
});
