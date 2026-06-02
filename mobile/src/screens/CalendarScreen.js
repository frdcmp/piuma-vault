import { Ionicons } from "@expo/vector-icons";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import {
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import BottomSheet from "../components/BottomSheet";
import DateTimePickerField from "../components/DateTimePickerField";
import {
	useCalendarEvents,
	useCreateEvent,
	useDeleteEvent,
	useUpdateEvent,
} from "../queries/calendarQuery";
import {
	useCompleteOccurrence,
	useRecurringTasks,
	useTasks,
	useToggleTask,
} from "../queries/tasksQuery";
import { formatTime } from "../utils/dateTime";
import { expandRecurrence } from "../utils/recurrence";
import { colors } from "../utils/theme";

const KEY = (d) => d.format("YYYY-MM-DD");
const WEEKDAYS = [
	{ id: "su", label: "S" },
	{ id: "mo", label: "M" },
	{ id: "tu", label: "T" },
	{ id: "we", label: "W" },
	{ id: "th", label: "T" },
	{ id: "fr", label: "F" },
	{ id: "sa", label: "S" },
];

export default function CalendarScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const [cursor, setCursor] = useState(() => dayjs().startOf("month"));
	const [selected, setSelected] = useState(() => dayjs().format("YYYY-MM-DD"));
	const [eventSheet, setEventSheet] = useState(null); // { event } | { date } | null

	const gridStart = useMemo(
		() => cursor.startOf("month").startOf("week"),
		[cursor],
	);
	const gridEnd = useMemo(() => cursor.endOf("month").endOf("week"), [cursor]);

	const { data: events = [] } = useCalendarEvents({
		from: gridStart.toISOString(),
		to: gridEnd.add(1, "day").toISOString(),
	});
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const toggleTask = useToggleTask();
	const completeOccurrence = useCompleteOccurrence();

	const materialized = useMemo(() => {
		const m = new Map();
		for (const t of tasks) {
			if (t.recurrence_id && t.occurrence_date)
				m.set(`${t.recurrence_id}|${t.occurrence_date}`, t);
		}
		return m;
	}, [tasks]);

	const byDay = useMemo(() => {
		const map = new Map();
		const bucket = (k) => {
			if (!map.has(k))
				map.set(k, { events: [], deadlines: [], occurrences: [] });
			return map.get(k);
		};
		for (const ev of events) bucket(KEY(dayjs(ev.starts_at))).events.push(ev);
		for (const t of tasks) {
			if (t.recurrence_id) continue;
			if (t.due_at) bucket(KEY(dayjs(t.due_at))).deadlines.push(t);
		}
		for (const tpl of recurring) {
			if (!tpl.active) continue;
			for (const occ of expandRecurrence({
				rrule: tpl.rrule,
				dtstart: tpl.dtstart,
				rangeStart: gridStart,
				rangeEnd: gridEnd,
				until: tpl.until,
			})) {
				bucket(occ.date).occurrences.push({
					template: tpl,
					date: occ.date,
					done: materialized.has(`${tpl.id}|${occ.date}`),
				});
			}
		}
		return map;
	}, [events, tasks, recurring, materialized, gridStart, gridEnd]);

	const weeks = useMemo(() => {
		const out = [];
		let d = gridStart;
		while (d.isBefore(gridEnd) || d.isSame(gridEnd, "day")) {
			const row = [];
			for (let i = 0; i < 7; i++) {
				row.push(d);
				d = d.add(1, "day");
			}
			out.push(row);
		}
		return out;
	}, [gridStart, gridEnd]);

	const todayKey = dayjs().format("YYYY-MM-DD");
	const sel = byDay.get(selected) || {
		events: [],
		deadlines: [],
		occurrences: [],
	};

	return (
		<View style={[s.root, { paddingTop: insets.top }]}>
			<View style={s.header}>
				<Pressable onPress={() => navigation.goBack()} hitSlop={10}>
					<Ionicons name="chevron-back" size={22} color={colors.text} />
				</Pressable>
				<Text style={s.title}>{cursor.format("MMMM YYYY")}</Text>
				<View style={s.headerNav}>
					<Pressable
						onPress={() => setCursor((c) => c.subtract(1, "month"))}
						hitSlop={8}
					>
						<Ionicons name="chevron-back" size={20} color={colors.muted} />
					</Pressable>
					<Pressable
						onPress={() => setCursor(dayjs().startOf("month"))}
						hitSlop={8}
					>
						<Text style={s.today}>today</Text>
					</Pressable>
					<Pressable
						onPress={() => setCursor((c) => c.add(1, "month"))}
						hitSlop={8}
					>
						<Ionicons name="chevron-forward" size={20} color={colors.muted} />
					</Pressable>
				</View>
			</View>

			<View style={s.weekRow}>
				{WEEKDAYS.map((w) => (
					<Text key={w.id} style={s.weekday}>
						{w.label}
					</Text>
				))}
			</View>
			{weeks.map((wk) => (
				<View key={KEY(wk[0])} style={s.gridRow}>
					{wk.map((day) => {
						const k = KEY(day);
						const cell = byDay.get(k);
						const other = day.month() !== cursor.month();
						const count =
							(cell?.events.length || 0) +
							(cell?.deadlines.length || 0) +
							(cell?.occurrences.length || 0);
						return (
							<Pressable
								key={k}
								style={[
									s.cell,
									k === selected && s.cellSel,
									k === todayKey && s.cellToday,
								]}
								onPress={() => setSelected(k)}
							>
								<Text style={[s.cellNum, other && s.cellOther]}>
									{day.date()}
								</Text>
								{count > 0 ? (
									<View style={s.dots}>
										{cell.events.length ? (
											<View style={[s.dot, s.dotEvent]} />
										) : null}
										{cell.deadlines.length || cell.occurrences.length ? (
											<View style={[s.dot, s.dotTask]} />
										) : null}
									</View>
								) : null}
							</Pressable>
						);
					})}
				</View>
			))}

			{/* Selected day detail */}
			<View style={s.detailHead}>
				<Text style={s.detailTitle}>
					{dayjs(selected).format("ddd, DD MMM")}
				</Text>
				<Pressable
					onPress={() => setEventSheet({ date: dayjs(selected) })}
					hitSlop={10}
				>
					<Text style={s.addEvent}>+ event</Text>
				</Pressable>
			</View>
			<ScrollView contentContainerStyle={s.detailScroll}>
				{sel.events.length + sel.deadlines.length + sel.occurrences.length ===
				0 ? (
					<Text style={s.empty}>Nothing on this day.</Text>
				) : null}
				{sel.events.map((ev) => (
					<Pressable
						key={ev.id}
						style={[s.item, { borderLeftColor: ev.color || colors.accent4 }]}
						onPress={() => setEventSheet({ event: ev })}
					>
						<Text style={s.itemTitle}>{ev.title}</Text>
						{!ev.all_day ? (
							<Text style={s.itemTime}>{formatTime(ev.starts_at)}</Text>
						) : (
							<Text style={s.itemTime}>all day</Text>
						)}
					</Pressable>
				))}
				{sel.occurrences.map((occ) => (
					<Pressable
						key={`${occ.template.id}-${occ.date}`}
						style={[s.item, s.itemTask]}
						onPress={() =>
							completeOccurrence.mutate({
								recurrenceId: occ.template.id,
								date: occ.date,
								done: !occ.done,
							})
						}
					>
						<Text style={s.check}>{occ.done ? "☑" : "☐"}</Text>
						<Text style={[s.itemTitle, occ.done && s.strike]}>
							{occ.template.title}
						</Text>
					</Pressable>
				))}
				{sel.deadlines.map((t) => (
					<Pressable
						key={t.id}
						style={[s.item, s.itemTask]}
						onPress={() => toggleTask.mutate(t.id)}
					>
						<Text style={s.check}>{t.done ? "☑" : "☐"}</Text>
						<Text style={[s.itemTitle, t.done && s.strike]}>{t.title}</Text>
					</Pressable>
				))}
			</ScrollView>

			{eventSheet ? (
				<EventSheet
					event={eventSheet.event}
					initialDate={eventSheet.date}
					onClose={() => setEventSheet(null)}
				/>
			) : null}
		</View>
	);
}

// ── Event create / edit / delete sheet ──────────────────────────────────────

function EventSheet({ event, initialDate, onClose }) {
	const isEdit = !!event;
	const createEvent = useCreateEvent();
	const updateEvent = useUpdateEvent();
	const deleteEvent = useDeleteEvent();

	const defaultStart = (initialDate || dayjs())
		.add(1, "hour")
		.minute(0)
		.second(0)
		.toISOString();

	const [title, setTitle] = useState(event?.title ?? "");
	const [allDay, setAllDay] = useState(event?.all_day ?? false);
	const [startsAt, setStartsAt] = useState(event?.starts_at ?? defaultStart);
	const [endsAt, setEndsAt] = useState(event?.ends_at ?? null);
	const [location, setLocation] = useState(event?.location ?? "");

	const save = () => {
		if (!title.trim()) return;
		const payload = {
			title: title.trim(),
			starts_at: startsAt,
			ends_at: endsAt || null,
			all_day: allDay,
			location: location.trim() || null,
		};
		const done = { onSuccess: onClose };
		if (isEdit) updateEvent.mutate({ id: event.id, ...payload }, done);
		else createEvent.mutate(payload, done);
	};

	return (
		<BottomSheet
			visible
			onClose={onClose}
			title={isEdit ? "Edit event" : "New event"}
		>
			<View style={s.form}>
				<Text style={s.label}>Title</Text>
				<TextInput
					style={s.input}
					value={title}
					onChangeText={setTitle}
					placeholder="Event title"
					placeholderTextColor={colors.muted}
				/>
				<Pressable style={s.allDayRow} onPress={() => setAllDay((v) => !v)}>
					<Text style={s.check}>{allDay ? "☑" : "☐"}</Text>
					<Text style={s.label}>All day</Text>
				</Pressable>
				<Text style={s.label}>Starts</Text>
				<DateTimePickerField
					value={startsAt}
					onChange={setStartsAt}
					mode={allDay ? "date" : "datetime"}
					clearable={false}
					placeholder="Pick start"
				/>
				<Text style={s.label}>Ends</Text>
				<DateTimePickerField
					value={endsAt}
					onChange={setEndsAt}
					mode={allDay ? "date" : "datetime"}
					placeholder="Optional"
				/>
				<Text style={s.label}>Location</Text>
				<TextInput
					style={s.input}
					value={location}
					onChangeText={setLocation}
					placeholder="Optional"
					placeholderTextColor={colors.muted}
				/>
				<Pressable style={s.saveBtn} onPress={save}>
					<Text style={s.saveBtnText}>Save</Text>
				</Pressable>
				{isEdit ? (
					<Pressable
						style={s.deleteBtn}
						onPress={() => deleteEvent.mutate(event.id, { onSuccess: onClose })}
					>
						<Text style={s.deleteText}>Delete event</Text>
					</Pressable>
				) : null}
			</View>
		</BottomSheet>
	);
}

const s = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	header: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	title: {
		color: colors.text,
		fontSize: 17,
		fontWeight: "600",
		flex: 1,
		marginLeft: 12,
	},
	headerNav: { flexDirection: "row", alignItems: "center", gap: 12 },
	today: { color: colors.accent, fontSize: 13 },
	weekRow: { flexDirection: "row", paddingTop: 8 },
	weekday: { flex: 1, textAlign: "center", color: colors.muted, fontSize: 11 },
	gridRow: { flexDirection: "row" },
	cell: {
		flex: 1,
		aspectRatio: 1,
		borderWidth: 0.5,
		borderColor: colors.border,
		padding: 4,
	},
	cellSel: { backgroundColor: colors.bgSoft, borderColor: colors.accent },
	cellToday: { borderColor: colors.accent4 },
	cellNum: { color: colors.text, fontSize: 12 },
	cellOther: { color: colors.muted, opacity: 0.5 },
	dots: { flexDirection: "row", gap: 3, marginTop: 2 },
	dot: { width: 5, height: 5, borderRadius: 3 },
	dotEvent: { backgroundColor: colors.accent4 },
	dotTask: { backgroundColor: colors.accent2 },
	detailHead: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingTop: 14,
		paddingBottom: 6,
	},
	detailTitle: { color: colors.text, fontSize: 14, letterSpacing: 0.5 },
	addEvent: { color: colors.accent, fontSize: 13 },
	detailScroll: { paddingHorizontal: 16, paddingBottom: 32 },
	empty: { color: colors.muted, fontStyle: "italic", fontSize: 13, padding: 4 },
	item: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		backgroundColor: colors.bgSoft,
		borderLeftWidth: 3,
		borderRadius: 4,
		paddingHorizontal: 10,
		paddingVertical: 8,
		marginBottom: 6,
	},
	itemTask: { borderLeftColor: colors.accent2 },
	itemTitle: { color: colors.text, fontSize: 14, flex: 1 },
	itemTime: { color: colors.muted, fontSize: 12 },
	check: { color: colors.accent2, fontSize: 16 },
	strike: { textDecorationLine: "line-through", color: colors.muted },
	// form
	form: { paddingHorizontal: 16, paddingTop: 4, gap: 6 },
	label: { color: colors.muted, fontSize: 12, marginTop: 6 },
	input: {
		backgroundColor: colors.bg,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 6,
		color: colors.text,
		paddingHorizontal: 10,
		paddingVertical: 9,
		fontSize: 14,
	},
	allDayRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: 8,
	},
	saveBtn: {
		backgroundColor: colors.accent,
		borderRadius: 6,
		paddingVertical: 11,
		alignItems: "center",
		marginTop: 14,
	},
	saveBtnText: { color: "#000", fontWeight: "700", fontSize: 15 },
	deleteBtn: { alignItems: "center", paddingVertical: 10 },
	deleteText: { color: colors.accent3, fontSize: 14 },
});
