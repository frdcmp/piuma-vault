import { Ionicons } from "@expo/vector-icons";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
	runOnJS,
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import {
	ActivityIndicator,
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
import ManageBucketsSheet from "../components/ManageBucketsSheet";
import TagPicker from "../components/TagPicker";
import {
	useCalendarEvent,
	useCalendarEvents,
	useCalendarLiveUpdates,
	useCreateEvent,
	useDeleteEvent,
	useUpdateEvent,
} from "../queries/calendarQuery";
import { useTagRegistry, useTagsLiveUpdates } from "../queries/tagsQuery";
import {
	useCompleteOccurrence,
	useRecurringTasks,
	useTasks,
	useTasksLiveUpdates,
	useToggleTask,
} from "../queries/tasksQuery";
import { usePrefsStore } from "../stores/prefsStore";
import { formatTime } from "../utils/dateTime";
import { syncLocalAlerts } from "../utils/notifications";
import { expandRecurrence } from "../utils/recurrence";
import { tagColor } from "../utils/tagColor";
import { colors } from "../utils/theme";

const ALL = { key: "all", names: null, label: "all" };

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

// Monday that starts the week containing `d` (week begins Monday — see memory).
const startOfWeekMonday = (d) =>
	d.subtract(mondayIndex(d), "day").startOf("day");

// Calendar layouts selectable from the filter bar (mobile only — web stays
// month-only). `month` is the infinite-scroll grid; `week`/`3day` are vertical
// agendas paged by their own length.
const VIEWS = [
	{ id: "month", label: "month", span: 0 },
	{ id: "week", label: "week", span: 7 },
	{ id: "3day", label: "3 days", span: 3 },
];

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

export default function CalendarScreen({ navigation, route }) {
	const insets = useSafeAreaInsets();
	// The calendar renders both events and tasks, so subscribe to both streams
	// to reflect changes made on another device.
	useCalendarLiveUpdates();
	useTasksLiveUpdates();
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

	// Deep-link: a Calendar route param `eventId` (set by a chat link/Go action)
	// opens that event's sheet. Fetch it by id, open it, then clear the param so
	// it doesn't reopen on the next focus.
	const deepEventId = route?.params?.eventId;
	const { data: deepEvent } = useCalendarEvent(deepEventId);
	useEffect(() => {
		if (deepEventId && deepEvent) {
			setEventSheet({ event: deepEvent });
			navigation.setParams({ eventId: undefined });
		}
	}, [deepEventId, deepEvent, navigation]);

	const [sel, setSel] = useState(ALL); // tag filter selection
	const [filterOpen, setFilterOpen] = useState(false);
	const [manageSheet, setManageSheet] = useState(false);
	// Persisted across launches so the calendar reopens in the last-used layout.
	const view = usePrefsStore((s) => s.calendarView); // "month" | "week" | "3day"
	const setView = usePrefsStore((s) => s.setCalendarView);
	// Anchor day for the agenda views; week derives its Monday from this.
	const [periodStart, setPeriodStart] = useState(() => dayjs().startOf("day"));

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
	const { data: tagRegistry = [] } = useTagRegistry();
	useTagsLiveUpdates("calendar");
	const toggleTask = useToggleTask();
	const completeOccurrence = useCompleteOccurrence();
	// Keys of the task/occurrence currently being toggled in the agenda views
	// (`t<id>` for tasks, `o<recurrenceId>-<date>` for occurrences). Lets each row
	// show its own spinner while the mutation is in flight, and re-enable its
	// checkbox the moment the cache reflects the new state.
	const [pendingKey, setPendingKey] = useState(null);
	const wrapToggle = (key, fn) => {
		setPendingKey(key);
		const done = {
			onSettled: () => setPendingKey((cur) => (cur === key ? null : cur)),
		};
		fn(done);
	};

	// Calendar filters by flat tags only (events have no bucket). Tag list is the
	// union of tags across the loaded events/tasks/recurring.
	const tagSet = new Set();
	for (const ev of events) for (const n of ev.tags ?? []) tagSet.add(n);
	for (const t of tasks) for (const n of t.tags ?? []) tagSet.add(n);
	for (const tpl of recurring) for (const n of tpl.tags ?? []) tagSet.add(n);
	const tagList = [...tagSet].sort();
	const tagColorOf = (name) =>
		tagRegistry.find((r) => r.name === name)?.color || tagColor(name);

	const selectAll = () => setSel(ALL);
	const selectTag = (name) =>
		setSel({ key: `tag:${name}`, names: [name], label: `#${name}` });

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
		// Bucket/tag filter (null names = show everything), applied uniformly.
		const matches = (tg) =>
			!sel.names || tg?.some((n) => sel.names.includes(n));
		for (const ev of events) {
			if (!matches(ev.tags)) continue;
			bucket(KEY(dayjs(ev.starts_at))).events.push(ev);
		}
		for (const t of tasks) {
			if (t.recurrence_id) continue;
			if (t.due_at && matches(t.tags))
				bucket(KEY(dayjs(t.due_at))).deadlines.push(t);
		}
		for (const tpl of recurring) {
			if (!tpl.active) continue;
			if (!matches(tpl.tags)) continue;
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
	}, [events, tasks, recurring, materialized, rangeStart, rangeEnd, sel.names]);

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

	const span = VIEWS.find((v) => v.id === view)?.span ?? 0;

	// The agenda carousel is an "infinite" strip of pages addressed by an absolute
	// integer index relative to `periodStart` (index 0 = the anchored period).
	// `pageIndex` (React state) drives which three pages render and the header
	// labels; `indexSV`/`drag` (shared values) drive the on-screen position.
	// Crucially the visible position depends ONLY on shared values updated
	// atomically on the UI thread — so a settled swipe never flashes the old page
	// while React catches up, because page content for a given absolute index is
	// deterministic and its on-screen slot is invariant across the re-render.
	const [pageIndex, setPageIndex] = useState(0);
	const indexSV = useSharedValue(0);
	const drag = useSharedValue(0);

	// Days for the page at absolute `index` (week pages snap to their Monday).
	const daysForIndex = useCallback(
		(index) => {
			if (!span) return [];
			const anchor = periodStart.add(index * span, "day");
			const start = view === "week" ? startOfWeekMonday(anchor) : anchor;
			return Array.from({ length: span }, (_, i) => start.add(i, "day"));
		},
		[span, view, periodStart],
	);

	// Current (centre) page days — also drives the header / nav labels.
	const agendaDays = useMemo(
		() => daysForIndex(pageIndex),
		[daysForIndex, pageIndex],
	);

	const agendaLabel = agendaDays.length
		? `${agendaDays[0].format("DD MMM")} – ${agendaDays[agendaDays.length - 1].format("DD MMM")}`
		: "";

	// Each page sits at `index * SCREEN_W`; the strip is shifted left by the
	// centre index so that page lands at screen 0, plus the live finger drag.
	const pagerStyle = useAnimatedStyle(() => ({
		transform: [{ translateX: -indexSV.value * SCREEN_W + drag.value }],
	}));

	// Catch React's page window up to a swipe that already settled on the UI
	// thread. By the time this runs `indexSV`/`drag` are already at their final
	// values, so this only re-renders content into slots that don't move.
	const commitIndex = useCallback((dir) => {
		setPageIndex((p) => p + dir);
	}, []);

	// Animate the strip one period in `dir`, then recentre on the UI thread and
	// hand the new index to React. Shared by the swipe gesture and the chevrons.
	const slidePeriod = useCallback(
		(dir) => {
			drag.value = withTiming(
				dir > 0 ? -SCREEN_W : SCREEN_W,
				{ duration: 220 },
				(finished) => {
					if (finished) {
						// Atomic on the UI thread: advancing the centre index while
						// zeroing the drag leaves translateX unchanged, so nothing jumps.
						indexSV.value += dir;
						drag.value = 0;
						runOnJS(commitIndex)(dir);
					}
				},
			);
		},
		[drag, indexSV, commitIndex],
	);

	// Hard-reset the carousel to the anchored "today" page (no animation).
	const resetAgenda = useCallback(
		(anchor) => {
			setPeriodStart(anchor);
			setPageIndex(0);
			indexSV.value = 0;
			drag.value = 0;
		},
		[indexSV, drag],
	);

	// Switching layout re-anchors to today so the user always lands on "now".
	const selectView = useCallback(
		(id) => {
			setView(id);
			resetAgenda(dayjs().startOf("day"));
			setFilterOpen(false);
		},
		[setView, resetAgenda],
	);

	// Horizontal swipe across the week / 3-day agenda. The finger drags the pages
	// live; on release a meaningful travel OR flick velocity slides to the next /
	// previous period, otherwise the page snaps back. Only activates on clearly
	// horizontal motion so the inner ScrollView keeps owning vertical scrolls and
	// taps. The gesture callbacks run on the UI thread as worklets, so React state
	// changes hop back via runOnJS.
	const swipeAgenda = useMemo(
		() =>
			Gesture.Pan()
				.activeOffsetX([-15, 15])
				.failOffsetY([-12, 12])
				.onUpdate((e) => {
					"worklet";
					drag.value = e.translationX;
				})
				.onEnd((e) => {
					"worklet";
					if (e.translationX < -60 || e.velocityX < -500)
						runOnJS(slidePeriod)(1);
					else if (e.translationX > 60 || e.velocityX > 500)
						runOnJS(slidePeriod)(-1);
					else drag.value = withTiming(0, { duration: 150 });
				}),
		[drag, slidePeriod],
	);

	const goToday = useCallback(() => {
		if (view === "month") scrollToToday();
		else resetAgenda(dayjs().startOf("day"));
	}, [view, scrollToToday, resetAgenda]);

	const headerTitle =
		view === "month"
			? visibleLabel
			: (agendaDays[0]?.format("MMMM YYYY") ?? visibleLabel);

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
				<Text style={s.title}>{headerTitle}</Text>
				<View style={s.headerRight}>
					<Pressable onPress={() => setFilterOpen((o) => !o)} hitSlop={8}>
						<Ionicons
							name={sel.key === "all" ? "filter-outline" : "filter"}
							size={18}
							color={sel.key === "all" ? colors.muted : colors.accent2}
						/>
					</Pressable>
					<Pressable onPress={goToday} hitSlop={8}>
						<Text style={s.today}>today</Text>
					</Pressable>
				</View>
			</View>

			{filterOpen ? (
				<View style={s.filterBar}>
					{/* View picker — a segmented control, distinct from the tag chips */}
					<View style={s.viewSeg}>
						{VIEWS.map((v, i) => {
							const on = view === v.id;
							return (
								<Pressable
									key={v.id}
									style={[
										s.viewSegItem,
										i === 0 && s.viewSegItemFirst,
										on && s.viewSegItemOn,
									]}
									onPress={() => selectView(v.id)}
								>
									<Text style={[s.viewSegText, on && s.viewSegTextOn]}>
										{v.label}
									</Text>
								</Pressable>
							);
						})}
					</View>
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						keyboardShouldPersistTaps="handled"
						contentContainerStyle={[s.filterRow, s.filterRowSub]}
					>
						<CalChip
							label="all"
							active={sel.key === "all"}
							onPress={selectAll}
						/>
						{tagList.map((name) => (
							<CalChip
								key={name}
								label={`#${name}`}
								color={tagColorOf(name)}
								active={sel.key === `tag:${name}`}
								onPress={() => selectTag(name)}
							/>
						))}
						<CalChip label="⚙ manage" onPress={() => setManageSheet(true)} />
					</ScrollView>
				</View>
			) : null}

			{view === "month" ? (
				<>
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
								offset:
									(layout[index]?.offset ?? index * averageItemHeight) || 0,
								animated: false,
							});
						}}
						showsVerticalScrollIndicator={false}
						contentContainerStyle={{
							paddingHorizontal: H_PAD,
							paddingBottom: insets.bottom + 24,
						}}
					/>
				</>
			) : (
				<View style={s.agendaBody}>
					<View style={s.agendaNav}>
						<Pressable onPress={() => slidePeriod(-1)} hitSlop={10}>
							<Ionicons name="chevron-back" size={20} color={colors.text} />
						</Pressable>
						<Text style={s.agendaNavLabel}>{agendaLabel}</Text>
						<Pressable onPress={() => slidePeriod(1)} hitSlop={10}>
							<Ionicons name="chevron-forward" size={20} color={colors.text} />
						</Pressable>
					</View>
					<GestureDetector gesture={swipeAgenda}>
						<Animated.View style={[s.pager, pagerStyle]}>
							{[pageIndex - 1, pageIndex, pageIndex + 1].map((index) => (
								<View
									key={index}
									style={[s.page, { transform: [{ translateX: index * SCREEN_W }] }]}
								>
									<AgendaView
										days={daysForIndex(index)}
										byDay={byDay}
										todayKey={todayKey}
										bottomPad={insets.bottom + 24}
										pendingKey={pendingKey}
										onOpenEvent={(ev) => setEventSheet({ event: ev })}
										onAddEvent={(day) => setEventSheet({ date: day })}
										onToggleTask={(id) =>
											wrapToggle(`t${id}`, (extra) =>
												toggleTask.mutate(id, extra),
											)
										}
										onToggleOccurrence={(occ) =>
											wrapToggle(`o${occ.template.id}-${occ.date}`, (extra) =>
												completeOccurrence.mutate(
													{
														recurrenceId: occ.template.id,
														date: occ.date,
														done: !occ.done,
													},
													extra,
												),
											)
										}
									/>
								</View>
							))}
						</Animated.View>
					</GestureDetector>
				</View>
			)}

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

			{manageSheet ? (
				<ManageBucketsSheet onClose={() => setManageSheet(false)} />
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
	const [tags, setTags] = useState(event?.tags ?? []);
	const [alerts, setAlerts] = useState(event?.alerts ?? []);

	const saving = createEvent.isPending || updateEvent.isPending;
	const deleting = deleteEvent.isPending;
	const busy = saving || deleting;

	const save = () => {
		if (!title.trim() || busy) return;
		const payload = {
			title: title.trim(),
			starts_at: startsAt,
			ends_at: endsAt || null,
			all_day: allDay,
			location: location.trim() || null,
			tags,
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
				<Text style={s.label}>Tags</Text>
				<TagPicker value={tags} onChange={setTags} />
				<Text style={s.label}>Alerts</Text>
				<AlertsField value={alerts} onChange={setAlerts} />
				<Pressable
					style={[s.saveBtn, busy && s.btnDisabled]}
					onPress={save}
					disabled={busy}
				>
					{saving ? (
						<ActivityIndicator color="#000" size="small" />
					) : (
						<Text style={s.saveBtnText}>Save</Text>
					)}
				</Pressable>
				{isEdit ? (
					<Pressable
						style={s.deleteBtn}
						onPress={() => deleteEvent.mutate(event.id, { onSuccess: onClose })}
						disabled={busy}
					>
						{deleting ? (
							<ActivityIndicator color={colors.accent3} size="small" />
						) : (
							<Text style={s.deleteText}>Delete event</Text>
						)}
					</Pressable>
				) : null}
			</View>
		</BottomSheet>
	);
}

// ── Week / 3-day agenda ──────────────────────────────────────────────────────
// A vertical list of day sections (header + full-width item rows), reusing the
// same item styling as the day sheet. Paged by the parent via `days`.
function AgendaView({
	days,
	byDay,
	todayKey,
	bottomPad,
	pendingKey,
	onOpenEvent,
	onAddEvent,
	onToggleTask,
	onToggleOccurrence,
}) {
	return (
		<ScrollView
			showsVerticalScrollIndicator={false}
			contentContainerStyle={{
				paddingHorizontal: H_PAD,
				paddingBottom: bottomPad,
			}}
		>
			{days.map((day) => {
				const data = byDay.get(KEY(day)) || EMPTY_DAY;
				const isToday = KEY(day) === todayKey;
				const empty =
					data.events.length +
						data.deadlines.length +
						data.occurrences.length ===
					0;
				return (
					<View key={KEY(day)} style={s.agendaDay}>
						<Pressable style={s.agendaDayHead} onPress={() => onAddEvent(day)}>
							<Text style={[s.agendaDayLabel, isToday && s.agendaDayToday]}>
								{day.format("ddd DD MMM")}
							</Text>
							<Text style={s.agendaAdd}>+</Text>
						</Pressable>
						{empty ? (
							<Text style={s.agendaEmpty}>—</Text>
						) : (
							<>
								{data.events.map((ev) => (
									<Pressable
										key={ev.id}
										style={[
											s.item,
											{ borderLeftColor: ev.color || colors.accent4 },
										]}
										onPress={() => onOpenEvent(ev)}
									>
										<Text style={s.itemTitle} numberOfLines={1}>
											{ev.title}
										</Text>
										<Text style={s.itemTime}>
											{ev.all_day ? "all day" : formatTime(ev.starts_at)}
										</Text>
									</Pressable>
								))}
								{data.occurrences.map((occ) => {
									const key = `o${occ.template.id}-${occ.date}`;
									const busy = pendingKey === key;
									return (
										<View
											key={key}
											style={[s.item, s.itemTask]}
										>
											<Pressable
												hitSlop={8}
												disabled={busy}
												onPress={() => onToggleOccurrence(occ)}
												style={s.checkHit}
											>
												{busy ? (
													<ActivityIndicator
														size="small"
														color={colors.accent2}
													/>
												) : (
													<Text style={s.check}>{occ.done ? "☑" : "☐"}</Text>
												)}
											</Pressable>
											<Text
												style={[s.itemTitle, occ.done && s.strike]}
												numberOfLines={1}
											>
												{occ.template.title}
											</Text>
										</View>
									);
								})}
								{data.deadlines.map((t) => {
									const key = `t${t.id}`;
									const busy = pendingKey === key;
									return (
										<View key={key} style={[s.item, s.itemTask]}>
											<Pressable
												hitSlop={8}
												disabled={busy}
												onPress={() => onToggleTask(t.id)}
												style={s.checkHit}
											>
												{busy ? (
													<ActivityIndicator
														size="small"
														color={colors.accent2}
													/>
												) : (
													<Text style={s.check}>{t.done ? "☑" : "☐"}</Text>
												)}
											</Pressable>
											<Text
												style={[s.itemTitle, t.done && s.strike]}
												numberOfLines={1}
											>
												{t.title}
											</Text>
										</View>
									);
								})}
							</>
						)}
					</View>
				);
			})}
		</ScrollView>
	);
}

// Filter chip for the calendar bucket/tag bar.
function CalChip({ label, active, color, onPress }) {
	return (
		<Pressable
			style={[s.calChip, active && s.calChipOn]}
			onPress={onPress}
			hitSlop={6}
		>
			<Text
				style={[s.calChipText, active && s.calChipTextOn, color && { color }]}
				numberOfLines={1}
			>
				{label}
			</Text>
		</Pressable>
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
	headerRight: { flexDirection: "row", alignItems: "center", gap: 14 },
	filterBar: {
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	filterRow: {
		flexDirection: "row",
		gap: 6,
		paddingHorizontal: 12,
		paddingVertical: 8,
	},
	filterRowSub: { paddingTop: 0 },
	// Segmented control for month / week / 3 days — one connected, full-width bar
	// split into three equal segments so it reads as a mode switch, not another
	// filter chip.
	viewSeg: {
		flexDirection: "row",
		marginHorizontal: 12,
		marginTop: 8,
		marginBottom: 6,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	viewSegItem: {
		flex: 1,
		paddingVertical: 10,
		alignItems: "center",
		justifyContent: "center",
		borderLeftWidth: 2,
		borderLeftColor: colors.borderStrong,
	},
	viewSegItemFirst: { borderLeftWidth: 0 },
	viewSegItemOn: { backgroundColor: colors.accent2 },
	viewSegText: {
		color: colors.muted,
		fontSize: 13,
		fontWeight: "700",
		letterSpacing: 0.3,
	},
	viewSegTextOn: { color: colors.bg, fontWeight: "800" },
	agendaBody: { flex: 1, overflow: "hidden" },
	// Pages are absolutely positioned at `index * SCREEN_W` (via an inline
	// transform) inside this strip; the animated strip offset brings the centre
	// page to screen 0. Addressing pages by absolute index keeps the visible slot
	// stable across a re-render, so settling a swipe never flashes the old page.
	pager: { flex: 1 },
	page: { position: "absolute", top: 0, bottom: 0, left: 0, width: SCREEN_W },
	agendaNav: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	agendaNavLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
	agendaDay: { marginTop: 14 },
	agendaDayHead: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
		paddingBottom: 4,
		marginBottom: 6,
	},
	agendaDayLabel: { color: colors.muted, fontSize: 13, fontWeight: "600" },
	agendaDayToday: { color: colors.accent },
	agendaAdd: { color: colors.accent, fontSize: 18, paddingHorizontal: 6 },
	agendaEmpty: { color: colors.muted, fontSize: 12, fontStyle: "italic" },
	calChip: {
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 10,
		paddingVertical: 5,
	},
	calChipOn: { borderColor: colors.accent2, backgroundColor: colors.bg },
	calChipText: { color: colors.text, fontSize: 12 },
	calChipTextOn: { color: colors.accent2 },
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
	// Fixed-size slot for the checkbox / spinner so toggling state doesn't
	// shift the row's baseline while a mutation is in flight.
	checkHit: { minWidth: 18, alignItems: "center", justifyContent: "center" },
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
		justifyContent: "center",
		minHeight: 42,
		marginTop: 14,
	},
	btnDisabled: { opacity: 0.6 },
	saveBtnText: { color: "#000", fontWeight: "700", fontSize: 15 },
	deleteBtn: { alignItems: "center", paddingVertical: 10 },
	deleteText: { color: colors.accent3, fontSize: 14 },
});
