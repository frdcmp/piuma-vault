import dayjs from "dayjs";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	useCalendarEvents,
	useCompleteOccurrence,
	useRecurringTasks,
	useTasks,
	useToggleTask,
} from "../../../queries";
import { expandRecurrence } from "../../../utils/recurrence";
import { PvButton } from "../../components/ui";
import "./Calendar.css";
import EventModal from "./EventModal";
import MonthGrid from "./MonthGrid";

const KEY = (d) => d.format("YYYY-MM-DD");

/**
 * Month calendar (pixel/terminal aesthetic). Shows three layers per day, all
 * bucketed in the user's LOCAL timezone:
 *   - events (db_calendar_events) on their start day
 *   - one-off tasks with a due_at (deadline pills)
 *   - recurring-task occurrences (expanded client-side from rrule templates)
 */
export default function CalendarPage() {
	const navigate = useNavigate();
	const [cursor, setCursor] = useState(() => dayjs().startOf("month"));
	const [modal, setModal] = useState(null); // { event } | { date } | null

	// 6-week grid covering the visible month, snapped to local week boundaries.
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

	// Bucket everything into local day cells.
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
				rangeStart: gridStart,
				rangeEnd: gridEnd,
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
	}, [events, tasks, recurring, materialized, gridStart, gridEnd]);

	// Build weeks (array of 7-day arrays).
	const weeks = useMemo(() => {
		const out = [];
		let day = gridStart;
		while (day.isBefore(gridEnd) || day.isSame(gridEnd, "day")) {
			const week = [];
			for (let i = 0; i < 7; i++) {
				week.push(day);
				day = day.add(1, "day");
			}
			out.push(week);
		}
		return out;
	}, [gridStart, gridEnd]);

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
					<span className="cal-glyph" aria-hidden="true">
						▤
					</span>
					<h1>{cursor.format("MMMM YYYY")}</h1>
				</div>
				<div className="cal-nav">
					<PvButton onClick={() => navigate("/")} variant="ghost">
						‹ home
					</PvButton>
					<PvButton
						onClick={() => setCursor((c) => c.subtract(1, "month"))}
					>
						‹
					</PvButton>
					<PvButton onClick={() => setCursor(dayjs().startOf("month"))}>
						today
					</PvButton>
					<PvButton onClick={() => setCursor((c) => c.add(1, "month"))}>
						›
					</PvButton>
					<PvButton
						variant="accent"
						onClick={() => setModal({ date: dayjs() })}
					>
						+ event
					</PvButton>
				</div>
			</header>

			<MonthGrid
				weeks={weeks}
				month={cursor.month()}
				byDay={byDay}
				keyOf={KEY}
				onEventClick={(ev) => setModal({ event: ev })}
				onDayClick={(d) => setModal({ date: d })}
				onToggleDeadline={(t) => toggleTask.mutate(t.id)}
				onToggleOccurrence={onToggleOccurrence}
			/>

			{modal ? (
				<EventModal
					event={modal.event}
					initialDate={modal.date}
					onClose={() => setModal(null)}
				/>
			) : null}
		</div>
	);
}
