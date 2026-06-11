import dayjs from "dayjs";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
	BucketTagFilter,
	ManageBucketsModal,
} from "../../../components/buckets";
import {
	useCalendarEvent,
	useCalendarEvents,
	useCalendarLiveUpdates,
	useCompleteOccurrence,
	useRecurringTasks,
	useTagRegistry,
	useTagsLiveUpdates,
	useTasks,
	useTasksLiveUpdates,
	useToggleTask,
} from "../../../queries";
import { expandRecurrence } from "../../../utils/recurrence";
import { tagColor } from "../../../utils/tagColor";
import {
	PvButton,
	PvPopover,
	PvTag,
	pvMessage,
} from "../../components/ui";
import RecurringTaskModal from "../tasks/RecurringTaskModal";
import TaskModal from "../tasks/TaskModal";
import "./Calendar.css";
import EventModal from "./EventModal";
import MonthBlock from "./MonthGrid";

const ALL = { key: "all", names: null, label: "All" };

const KEY = (d) => d.format("YYYY-MM-DD");
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// How many months sit on each side of the current month at first paint, and how
// many to prepend/append each time the user scrolls near an edge.
const PAST_MONTHS = 12;
const FUTURE_MONTHS = 12;
const CHUNK = 12;
// Distance (px) from a scroll edge at which we grow the window.
const EDGE = 800;

/**
 * Continuous month calendar (pixel/terminal aesthetic), mirroring the mobile
 * agenda: an infinite vertical scroll of month blocks. The visible window grows
 * in both directions as you scroll, and the events query range follows it so
 * data is lazy-loaded per window. Three layers per day, all bucketed in the
 * user's LOCAL timezone:
 *   - events (db_calendar_events) on their start day
 *   - one-off tasks with a due_at (deadline pills)
 *   - recurring-task occurrences (expanded client-side from rrule templates)
 */
export default function CalendarPage() {
	const navigate = useNavigate();
	// The calendar renders both events and tasks, so subscribe to both streams
	// to reflect changes made in another tab/device.
	useCalendarLiveUpdates();
	useTasksLiveUpdates();
	useTagsLiveUpdates("calendar");

	const scrollRef = useRef(null);
	const todayBlockRef = useRef(null);
	const didInit = useRef(false); // one-time scroll-to-today on first layout
	const pendingPrepend = useRef(null); // { prevHeight, prevTop } for scroll compensation
	const busy = useRef(false); // guards against firing many grows per scroll burst

	// Fixed anchor (current month); the window extends `past` months back and
	// `future` months forward. The current month always sits at index `past`.
	const [base] = useState(() => dayjs().startOf("month"));
	const [past, setPast] = useState(PAST_MONTHS);
	const [future, setFuture] = useState(FUTURE_MONTHS);
	const [visibleLabel, setVisibleLabel] = useState(() =>
		dayjs().format("MMMM YYYY"),
	);
	const [modal, setModal] = useState(null); // { event } | { date } | null
	const [sel, setSel] = useState(ALL); // bucket/tag filter selection
	const [filterOpen, setFilterOpen] = useState(false);
	const [manageOpen, setManageOpen] = useState(false);
	const [taskModal, setTaskModal] = useState(null); // { task } | null
	const [recModal, setRecModal] = useState(null); // { recurring } | null
	const tagsBtnRef = useRef(null); // anchors the tags filter popover

	const { data: tagRegistry = [] } = useTagRegistry();
	const tagColorOf = (name) =>
		tagRegistry.find((r) => r.name === name)?.color || tagColor(name);

	const months = useMemo(() => {
		const arr = [];
		for (let i = -past; i <= future; i++) arr.push(base.add(i, "month"));
		return arr;
	}, [base, past, future]);

	// Window bounds (memoised so byDay's deps stay stable across renders).
	const rangeStart = useMemo(() => months[0].startOf("month"), [months]);
	const rangeEnd = useMemo(
		() => months[months.length - 1].endOf("month"),
		[months],
	);

	const { data: events = [] } = useCalendarEvents({
		from: rangeStart.toISOString(),
		to: rangeEnd.add(1, "day").toISOString(),
	});
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const toggleTask = useToggleTask();
	const completeOccurrence = useCompleteOccurrence();

	// Deep-link: /calendar?event=<id> opens that event's modal (e.g. from a
	// chat link). Fetch the event by id, open it, and clear the param on close so
	// it doesn't reopen. A missing/forbidden id degrades to a toast.
	const [searchParams, setSearchParams] = useSearchParams();
	const deepEventId = searchParams.get("event");
	const { data: deepEvent, error: deepEventError } =
		useCalendarEvent(deepEventId);
	const clearEventParam = useCallback(() => {
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("event");
				return next;
			},
			{ replace: true },
		);
	}, [setSearchParams]);
	useEffect(() => {
		if (deepEventId && deepEvent) setModal({ event: deepEvent });
	}, [deepEventId, deepEvent]);
	useEffect(() => {
		if (deepEventId && deepEventError) {
			pvMessage.error("That event couldn't be found.");
			clearEventParam();
		}
	}, [deepEventId, deepEventError, clearEventParam]);

	// Completed recurring occurrences, keyed "recurrenceId|YYYY-MM-DD".
	const materialized = useMemo(() => {
		const m = new Map();
		for (const t of tasks) {
			if (t.recurrence_id && t.occurrence_date) {
				m.set(`${t.recurrence_id}|${t.occurrence_date}`, t);
			}
		}
		return m;
	}, [tasks]);

	// Bucket everything into local day cells across the whole visible window.
	const byDay = useMemo(() => {
		const map = new Map();
		const bucket = (key) => {
			if (!map.has(key))
				map.set(key, { events: [], deadlines: [], occurrences: [] });
			return map.get(key);
		};

		// Bucket/tag filter: null names = show everything, else require an overlap
		// with the selection (applied uniformly to events, deadlines, occurrences).
		const matches = (t) => !sel.names || t?.some((n) => sel.names.includes(n));

		for (const ev of events) {
			if (!matches(ev.tags)) continue;
			bucket(KEY(dayjs(ev.starts_at))).events.push(ev);
		}
		for (const t of tasks) {
			if (t.recurrence_id) continue; // materialized occurrences handled below
			if (t.due_at && matches(t.tags))
				bucket(KEY(dayjs(t.due_at))).deadlines.push(t);
		}
		for (const tpl of recurring) {
			if (!tpl.active) continue;
			if (!matches(tpl.tags)) continue;
			const occs = expandRecurrence({
				rrule: tpl.rrule,
				dtstart: tpl.dtstart,
				rangeStart,
				rangeEnd,
				until: tpl.until,
			});
			for (const occ of occs) {
				const done = materialized.has(`${tpl.id}|${occ.date}`);
				bucket(occ.date).occurrences.push({
					template: tpl,
					date: occ.date,
					done,
				});
			}
		}
		return map;
	}, [events, tasks, recurring, materialized, rangeStart, rangeEnd, sel.names]);

	// Grow the window when scrolling near either edge. A single `busy` latch
	// prevents adding many chunks in one scroll burst; it clears once the new
	// months have rendered (the layout effect below, keyed on `months`).
	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el || busy.current) return;
		const distToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distToBottom < EDGE) {
			busy.current = true;
			setFuture((f) => f + CHUNK);
		} else if (el.scrollTop < EDGE) {
			busy.current = true;
			// Record the pre-prepend geometry so we can keep the viewport anchored
			// after the new months are inserted above.
			pendingPrepend.current = {
				prevHeight: el.scrollHeight,
				prevTop: el.scrollTop,
			};
			setPast((p) => p + CHUNK);
		}
	}, []);

	// Runs after every window change: on first paint, jump to the current month;
	// after a prepend, compensate scrollTop so the viewport doesn't jump; always
	// release the `busy` latch.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the month window grows
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (!didInit.current) {
			const block = todayBlockRef.current;
			if (block) {
				el.scrollTop = block.offsetTop;
				didInit.current = true;
			}
		} else if (pendingPrepend.current) {
			const { prevHeight, prevTop } = pendingPrepend.current;
			el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
			pendingPrepend.current = null;
		}
		busy.current = false;
	}, [months]);

	// Track the month occupying the top of the viewport for the header label.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-observe the freshly-rendered month blocks
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const io = new IntersectionObserver(
			(entries) => {
				const top = entries
					.filter((e) => e.isIntersecting)
					.sort(
						(a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
					)[0];
				if (top) setVisibleLabel(top.target.dataset.label);
			},
			// Active zone = the top sliver of the scroll container.
			{ root: el, rootMargin: "0px 0px -85% 0px", threshold: 0 },
		);
		for (const block of el.querySelectorAll(".cal-month")) io.observe(block);
		return () => io.disconnect();
	}, [months]);

	const scrollToToday = useCallback(() => {
		const el = scrollRef.current;
		const block = todayBlockRef.current;
		if (el && block) el.scrollTo({ top: block.offsetTop, behavior: "smooth" });
	}, []);

	const onToggleOccurrence = (occ) => {
		completeOccurrence.mutate({
			recurrenceId: occ.template.id,
			date: occ.date,
			done: !occ.done,
		});
	};

	return (
		<div className="cal-page">
			<header className="cal-header">
				<div className="cal-title">
					<PvButton onClick={() => navigate("/notes")} variant="ghost">
						‹ home
					</PvButton>
					<span className="cal-glyph" aria-hidden="true">
						▤
					</span>
					<h1>{visibleLabel}</h1>
				</div>
				<div className="cal-nav">
					<span ref={tagsBtnRef} className="cal-tags-anchor">
						{sel.key === "all" ? (
							<PvButton
								variant="ghost"
								onClick={() => setFilterOpen((o) => !o)}
							>
								tags ▾
							</PvButton>
						) : (
							<PvTag
								color={sel.names?.[0] ? tagColorOf(sel.names[0]) : undefined}
								onClick={() => setFilterOpen((o) => !o)}
								onRemove={() => setSel(ALL)}
								removeLabel="Clear filter"
							>
								{sel.label}
							</PvTag>
						)}
					</span>
					<PvButton onClick={scrollToToday}>today</PvButton>
					<PvButton
						variant="accent"
						onClick={() => setModal({ date: dayjs() })}
					>
						+ event
					</PvButton>
				</div>
			</header>

			<PvPopover
				open={filterOpen}
				anchorRef={tagsBtnRef}
				align="end"
				width={300}
				className="cal-filter-popover"
				onClose={() => setFilterOpen(false)}
			>
				<div className="cal-filter-head">
					<button
						type="button"
						className="tasks-manage-btn"
						onClick={() => {
							setFilterOpen(false);
							setManageOpen(true);
						}}
					>
						⚙ manage
					</button>
					<button
						type="button"
						className="tasks-manage-btn"
						onClick={() => setFilterOpen(false)}
					>
						close ✕
					</button>
				</div>
				<BucketTagFilter
					scope="calendar"
					items={[...events, ...tasks, ...recurring]}
					selectedKey={sel.key}
					onSelect={(s) => {
						setSel(s);
						setFilterOpen(false);
					}}
				/>
			</PvPopover>

			<div className="cal-weekdays">
				{WEEKDAYS.map((w) => (
					<div key={w} className="cal-weekday">
						{w}
					</div>
				))}
			</div>

			<div className="cal-scroll" ref={scrollRef} onScroll={onScroll}>
				{months.map((m) => (
					<MonthBlock
						key={m.format("YYYY-MM")}
						ref={m.isSame(base, "month") ? todayBlockRef : undefined}
						month={m}
						byDay={byDay}
						keyOf={KEY}
						onEventClick={(ev) => setModal({ event: ev })}
						onDayClick={(d) => setModal({ date: d })}
						onDeadlineClick={(t) => setTaskModal({ task: t })}
						onOccurrenceClick={(occ) =>
							setRecModal({ recurring: occ.template })
						}
						onToggleDeadline={(t) => toggleTask.mutate(t.id)}
						onToggleOccurrence={onToggleOccurrence}
					/>
				))}
			</div>

			{modal ? (
				<EventModal
					event={modal.event}
					initialDate={modal.date}
					onClose={() => {
						setModal(null);
						clearEventParam();
					}}
				/>
			) : null}
			{taskModal ? (
				<TaskModal task={taskModal.task} onClose={() => setTaskModal(null)} />
			) : null}
			{recModal ? (
				<RecurringTaskModal
					recurring={recModal.recurring}
					onClose={() => setRecModal(null)}
				/>
			) : null}
			{manageOpen ? (
				<ManageBucketsModal onClose={() => setManageOpen(false)} />
			) : null}
		</div>
	);
}
