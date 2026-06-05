import dayjs from "dayjs";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useNavigate } from "react-router-dom";
import WorkspaceShell from "../../../chat/WorkspaceShell";
import {
	useCalendarEvents,
	useCalendarLiveUpdates,
	useCompleteOccurrence,
	useRecurringTasks,
	useTasks,
	useTasksLiveUpdates,
	useToggleTask,
} from "../../../queries";
import { expandRecurrence } from "../../../utils/recurrence";
import { PvButton } from "../../components/ui";
import "./Calendar.css";
import EventModal from "./EventModal";
import MonthBlock from "./MonthGrid";

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

		for (const ev of events) {
			bucket(KEY(dayjs(ev.starts_at))).events.push(ev);
		}
		for (const t of tasks) {
			if (t.recurrence_id) continue; // materialized occurrences handled below
			if (t.due_at) bucket(KEY(dayjs(t.due_at))).deadlines.push(t);
		}
		for (const tpl of recurring) {
			if (!tpl.active) continue;
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
	}, [events, tasks, recurring, materialized, rangeStart, rangeEnd]);

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
		<WorkspaceShell>
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
						<PvButton onClick={scrollToToday}>today</PvButton>
						<PvButton
							variant="accent"
							onClick={() => setModal({ date: dayjs() })}
						>
							+ event
						</PvButton>
					</div>
				</header>

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
							onToggleDeadline={(t) => toggleTask.mutate(t.id)}
							onToggleOccurrence={onToggleOccurrence}
						/>
					))}
				</div>

				{modal ? (
					<EventModal
						event={modal.event}
						initialDate={modal.date}
						onClose={() => setModal(null)}
					/>
				) : null}
			</div>
		</WorkspaceShell>
	);
}
