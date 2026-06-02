import { Ionicons } from "@expo/vector-icons";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Dimensions,
	FlatList,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AlertsField from "../components/AlertsField";
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
import { syncLocalAlerts } from "../utils/notifications";
import { expandRecurrence } from "../utils/recurrence";
import { colors } from "../utils/theme";

const KEY = (d) => d.format("YYYY-MM-DD");
const WEEKDAYS = [
	{ id: "mo", label: "M" },
	{ id: "tu", label: "T" },
	{ id: "we", label: "W" },
	{ id: "th", label: "T" },
	{ id: "fr", label: "F" },
	{ id: "sa", label: "S" },
	{ id: "su", label: "S" },
];

// Monday-based weekday index (0 = Monday … 6 = Sunday) from dayjs's Sunday-based
// `.day()` (0 = Sunday). Used for grid offsets so the week starts on Monday.
const mondayIndex = (d) => (d.day() + 6) % 7;

const EMPTY_DAY = { events: [], deadlines: [], occurrences: [] };
// How many months of history to keep above "today" so the user can scroll up a
// little, and how many future months to add each time the bottom is reached.
const PAST_MONTHS = 12;
const FUTURE_CHUNK = 12;

const { width: SCREEN_W } = Dimensions.get("window");
const H_PAD = 12; // left/right gutter around the calendar grid
const CELL_W = Math.floor((SCREEN_W - H_PAD * 2) / 7);
// Cells are taller than wide so each can show a couple of event/task titles
// under the date number (web shows pills; mobile shows compact chips).
const CELL_H = 74;
const MAX_CHIPS = 2; // titles shown per day before collapsing to "+N"
const MONTH_HEADER_H = 44;

// Flatten a day's bucket into compact chip descriptors (events first, then
// recurring occurrences, then one-off deadlines).
const dayChips = (data) => {
	if (!data) return [];
	const out = [];
	for (const ev of data.events)
		out.push({
			key: `e${ev.id}`,
			label: ev.title,
			color: ev.color || colors.accent4,
		});
	for (const occ of data.occurrences)
		out.push({
			key: `o${occ.template.id}-${occ.date}`,
			label: occ.template.title,
			color: colors.accent2,
			done: occ.done,
		});
	for (const t of data.deadlines)
		out.push({
			key: `d${t.id}`,
			label: t.title,
			color: colors.accent2,
			done: t.done,
		});
	return out;
};

// Sunday-based week math, matching the WEEKDAYS header. `weeksInMonth` lets us
// give FlatList an exact getItemLayout so initialScrollIndex / scrollToIndex
// land precisely on a month despite variable (4–6 week) block heights.
const weeksInMonth = (month) =>
	Math.ceil((mondayIndex(month.startOf("month")) + month.daysInMonth()) / 7);

// Build a month into rows of 7 slots; leading/trailing slots outside the month
// are null (rendered blank) for a clean Airbnb-style block.
const buildWeeks = (month) => {
	const first = month.startOf("month");
	const offset = mondayIndex(first);
	const total = month.daysInMonth();
	const cells = [];
	for (let i = 0; i < offset; i++) cells.push(null);
	for (let d = 1; d <= total; d++) cells.push(first.date(d));
	while (cells.length % 7 !== 0) cells.push(null);
	const weeks = [];
	for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
	return weeks;
};

function DayCell({ day, data, isToday, onPress }) {
	const chips = dayChips(data);
	const shown = chips.slice(0, MAX_CHIPS);
	const overflow = chips.length - shown.length;
	return (
		<Pressable
			style={[s.cell, isToday && s.cellToday]}
			onPress={() => onPress(day)}
		>
			<Text style={s.cellNum}>{day.date()}</Text>
			{shown.map((c) => (
				<View key={c.key} style={s.chip}>
					<View style={[s.chipBar, { backgroundColor: c.color }]} />
					<Text style={[s.chipText, c.done && s.chipDone]} numberOfLines={1}>
						{c.label}
					</Text>
				</View>
			))}
			{overflow > 0 ? <Text style={s.chipMore}>+{overflow}</Text> : null}
		</Pressable>
	);
}

function MonthBlock({ month, byDay, todayKey, onPickDay }) {
	const weeks = useMemo(() => buildWeeks(month), [month]);
	return (
		<View>
			<Text style={s.monthLabel}>{month.format("MMMM YYYY")}</Text>
			{weeks.map((wk, wi) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: week rows are positional
				<View key={wi} style={s.gridRow}>
					{wk.map((day, di) =>
						day ? (
							<DayCell
								key={KEY(day)}
								day={day}
								data={byDay.get(KEY(day))}
								isToday={KEY(day) === todayKey}
								onPress={onPickDay}
							/>
						) : (
							// biome-ignore lint/suspicious/noArrayIndexKey: blank padding cell
							<View key={`x${di}`} style={s.cellEmpty} />
						),
					)}
				</View>
			))}
		</View>
	);
}

export default function CalendarScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const listRef = useRef(null);
	// Fixed base month (PAST_MONTHS before the current month); the visible window
	// grows forward via `future`. The current month always sits at PAST_MONTHS.
	const [base] = useState(() =>
		dayjs().startOf("month").subtract(PAST_MONTHS, "month"),
	);
	const [future, setFuture] = useState(FUTURE_CHUNK);
	const [visibleLabel, setVisibleLabel] = useState(() =>
		dayjs().format("MMMM YYYY"),
	);
	const [daySheet, setDaySheet] = useState(null); // dayjs | null
	const [eventSheet, setEventSheet] = useState(null); // { event } | { date } | null
	const pendingEvent = useRef(null); // chains daySheet -> eventSheet across the close animation

	const months = useMemo(() => {
		const arr = [];
		for (let i = 0; i < PAST_MONTHS + 1 + future; i++)
			arr.push(base.add(i, "month"));
		return arr;
	}, [base, future]);

	// Precompute per-month heights + offsets for exact FlatList layout.
	const layout = useMemo(() => {
		let offset = 0;
		return months.map((m) => {
			const length = MONTH_HEADER_H + weeksInMonth(m) * CELL_H;
			const entry = { length, offset };
			offset += length;
			return entry;
		});
	}, [months]);

	const rangeStart = months[0].startOf("month");
	const rangeEnd = months[months.length - 1].endOf("month");

	const { data: events = [] } = useCalendarEvents({
		from: rangeStart.toISOString(),
		to: rangeEnd.toISOString(),
	});
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const toggleTask = useToggleTask();
	const completeOccurrence = useCompleteOccurrence();

	// Keep on-device local notifications in sync with the loaded agenda data, so
	// alerts fire offline. Remote push (notification-worker) covers anything
	// beyond the local horizon. Best-effort; safe to re-run on data changes.
	useEffect(() => {
		syncLocalAlerts({ events, tasks, recurring });
	}, [events, tasks, recurring]);

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
				rangeStart,
				rangeEnd,
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
	}, [events, tasks, recurring, materialized, rangeStart, rangeEnd]);

	const todayKey = dayjs().format("YYYY-MM-DD");

	const onPickDay = useCallback((day) => setDaySheet(day), []);

	const renderMonth = useCallback(
		({ item }) => (
			<MonthBlock
				month={item}
				byDay={byDay}
				todayKey={todayKey}
				onPickDay={onPickDay}
			/>
		),
		[byDay, todayKey, onPickDay],
	);

	const getItemLayout = useCallback(
		(_data, index) => ({ ...layout[index], index }),
		[layout],
	);

	const onViewable = useRef(({ viewableItems }) => {
		const first = viewableItems[0]?.item;
		if (first) setVisibleLabel(first.format("MMMM YYYY"));
	}).current;
	const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 30 }).current;

	const scrollToToday = useCallback(() => {
		listRef.current?.scrollToIndex({ index: PAST_MONTHS, animated: true });
	}, []);

	// Tapping an item inside the day sheet opens the event sheet, but RN can only
	// show one modal at a time — so we stash the target and open it once the day
	// sheet has finished sliding out (onClosed).
	const openEventFromDay = useCallback((target) => {
		// Stash the target only. DaySheet's own `closing` state animates it out;
		// the parent clears `daySheet` in onDaySheetClosed once the slide-out
		// finishes — clearing it here would unmount the sheet before its exit
		// animation runs, so `onClosed` (which opens the event sheet) never fires.
		pendingEvent.current = target;
	}, []);
	const onDaySheetClosed = useCallback(() => {
		setDaySheet(null);
		if (pendingEvent.current) {
			setEventSheet(pendingEvent.current);
			pendingEvent.current = null;
		}
	}, []);

	return (
		<View style={[s.root, { paddingTop: insets.top }]}>
			<View style={s.header}>
				<Pressable onPress={() => navigation.goBack()} hitSlop={10}>
					<Ionicons name="chevron-back" size={22} color={colors.text} />
				</Pressable>
				<Text style={s.title}>{visibleLabel}</Text>
				<Pressable onPress={scrollToToday} hitSlop={8}>
					<Text style={s.today}>today</Text>
				</Pressable>
			</View>

			<View style={s.weekRow}>
				{WEEKDAYS.map((w) => (
					<Text key={w.id} style={s.weekday}>
						{w.label}
					</Text>
				))}
			</View>

			<FlatList
				ref={listRef}
				data={months}
				keyExtractor={(m) => m.format("YYYY-MM")}
				renderItem={renderMonth}
				getItemLayout={getItemLayout}
				initialScrollIndex={PAST_MONTHS}
				initialNumToRender={4}
				windowSize={9}
				onEndReached={() => setFuture((f) => f + FUTURE_CHUNK)}
				onEndReachedThreshold={1.5}
				onViewableItemsChanged={onViewable}
				viewabilityConfig={viewabilityConfig}
				onScrollToIndexFailed={({ index, averageItemHeight }) => {
					listRef.current?.scrollToOffset({
						offset: (layout[index]?.offset ?? index * averageItemHeight) || 0,
						animated: false,
					});
				}}
				showsVerticalScrollIndicator={false}
				contentContainerStyle={{
					paddingHorizontal: H_PAD,
					paddingBottom: insets.bottom + 24,
				}}
			/>

			{daySheet ? (
				<DaySheet
					date={daySheet}
					data={byDay.get(KEY(daySheet)) || EMPTY_DAY}
					onClosed={onDaySheetClosed}
					onAddEvent={() => openEventFromDay({ date: daySheet })}
					onOpenEvent={(ev) => openEventFromDay({ event: ev })}
					onToggleTask={(id) => toggleTask.mutate(id)}
					onToggleOccurrence={(occ) =>
						completeOccurrence.mutate({
							recurrenceId: occ.template.id,
							date: occ.date,
							done: !occ.done,
						})
					}
				/>
			) : null}

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

// ── Selected-day agenda sheet ────────────────────────────────────────────────

function DaySheet({
	date,
	data,
	onClosed,
	onAddEvent,
	onOpenEvent,
	onToggleTask,
	onToggleOccurrence,
}) {
	const [closing, setClosing] = useState(false);
	const empty =
		data.events.length + data.deadlines.length + data.occurrences.length === 0;

	// Run an action, then start the close animation; `onClosed` chains follow-ups.
	const act = (fn) => {
		fn();
		setClosing(true);
	};

	return (
		<BottomSheet
			visible={!closing}
			onClose={() => setClosing(true)}
			onClosed={onClosed}
			title={date.format("ddd, DD MMM")}
		>
			<ScrollView contentContainerStyle={s.detailScroll}>
				{empty ? <Text style={s.empty}>Nothing on this day.</Text> : null}
				{data.events.map((ev) => (
					<Pressable
						key={ev.id}
						style={[s.item, { borderLeftColor: ev.color || colors.accent4 }]}
						onPress={() => act(() => onOpenEvent(ev))}
					>
						<Text style={s.itemTitle}>{ev.title}</Text>
						<Text style={s.itemTime}>
							{ev.all_day ? "all day" : formatTime(ev.starts_at)}
						</Text>
					</Pressable>
				))}
				{data.occurrences.map((occ) => (
					<Pressable
						key={`${occ.template.id}-${occ.date}`}
						style={[s.item, s.itemTask]}
						onPress={() => onToggleOccurrence(occ)}
					>
						<Text style={s.check}>{occ.done ? "☑" : "☐"}</Text>
						<Text style={[s.itemTitle, occ.done && s.strike]}>
							{occ.template.title}
						</Text>
					</Pressable>
				))}
				{data.deadlines.map((t) => (
					<Pressable
						key={t.id}
						style={[s.item, s.itemTask]}
						onPress={() => onToggleTask(t.id)}
					>
						<Text style={s.check}>{t.done ? "☑" : "☐"}</Text>
						<Text style={[s.itemTitle, t.done && s.strike]}>{t.title}</Text>
					</Pressable>
				))}
				<Pressable style={s.addEventBtn} onPress={() => act(onAddEvent)}>
					<Text style={s.addEvent}>+ event</Text>
				</Pressable>
			</ScrollView>
		</BottomSheet>
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
	const [alerts, setAlerts] = useState(event?.alerts ?? []);

	const save = () => {
		if (!title.trim()) return;
		const payload = {
			title: title.trim(),
			starts_at: startsAt,
			ends_at: endsAt || null,
			all_day: allDay,
			location: location.trim() || null,
			alerts,
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
				<Text style={s.label}>Alerts</Text>
				<AlertsField value={alerts} onChange={setAlerts} />
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
	today: { color: colors.accent, fontSize: 13 },
	weekRow: {
		flexDirection: "row",
		paddingVertical: 8,
		paddingHorizontal: H_PAD,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	weekday: { flex: 1, textAlign: "center", color: colors.muted, fontSize: 11 },
	monthLabel: {
		color: colors.text,
		fontSize: 15,
		fontWeight: "600",
		height: MONTH_HEADER_H,
		lineHeight: MONTH_HEADER_H,
		paddingHorizontal: 2,
	},
	gridRow: { flexDirection: "row" },
	cell: {
		width: CELL_W,
		height: CELL_H,
		borderWidth: 0.5,
		borderColor: colors.border,
		paddingHorizontal: 3,
		paddingTop: 2,
	},
	cellEmpty: { width: CELL_W, height: CELL_H },
	cellToday: { borderColor: colors.accent4, backgroundColor: colors.bgSoft },
	cellNum: { color: colors.text, fontSize: 12, marginBottom: 1 },
	chip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 2,
		marginTop: 1,
	},
	chipBar: { width: 2, height: 9, borderRadius: 1 },
	chipText: { flex: 1, color: colors.text, fontSize: 8, lineHeight: 10 },
	chipDone: { textDecorationLine: "line-through", color: colors.muted },
	chipMore: { color: colors.muted, fontSize: 8, marginTop: 1, marginLeft: 4 },
	addEventBtn: { paddingVertical: 12, alignItems: "center" },
	addEvent: { color: colors.accent, fontSize: 14 },
	detailScroll: { paddingBottom: 12 },
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
