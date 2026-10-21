import dayjs from "dayjs";
import { forwardRef } from "react";
import { formatDate, formatTime } from "../../../utils/dateTime";

const KEY = (d) => d.format("YYYY-MM-DD");

// Event colours when the event has none of its own: one theme colour per event,
// picked from its id so it stays the same everywhere (the Android widget uses the
// same palette and hash).
const BAR_VARS = [
	"--vp-accent",
	"--vp-info",
	"--vp-success",
	"--vp-violet",
	"--vp-warning",
	"--vp-danger",
];
export const eventColor = (ev) => {
	if (ev.color) return ev.color;
	let h = 0;
	for (const ch of ev.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return `var(${BAR_VARS[h % BAR_VARS.length]})`;
};

const KIND_ORDER = { bar: 0, timed: 1, task: 2 };

// 6-week grid snapped to local Monday week boundaries. dayjs is configured with
// a Monday week start, so startOf("week") lands on Monday (matches the header).
const buildWeeks = (month) => {
	const start = month.startOf("month").startOf("week");
	const end = month.endOf("month").endOf("week");
	const weeks = [];
	let day = start;
	while (day.isBefore(end) || day.isSame(end, "day")) {
		const week = [];
		for (let i = 0; i < 7; i++) {
			week.push(day);
			day = day.add(1, "day");
		}
		weeks.push(week);
	}
	return weeks;
};

// Lane layout of one week, as in the widget: bars first (earliest start, then
// longest), then timed events by time, then tasks — each into the lowest lane
// free over all its columns. Only this month's days take chips; the padding
// days stay blank, so a bar crossing into another month stops at the edge.
const layoutWeek = (items, week, month) => {
	const cols = week
		.map((d, i) => (d.month() === month.month() ? i : -1))
		.filter((i) => i >= 0);
	const firstCol = cols[0];
	const lastCol = cols[cols.length - 1];
	const from = week[firstCol];
	const to = week[lastCol];
	const placed = items
		.filter((it) => !it.first.isAfter(to) && !it.last.isBefore(from))
		.map((it) => ({
			...it,
			c0: Math.max(firstCol, it.first.diff(week[0], "day")),
			c1: Math.min(lastCol, it.last.diff(week[0], "day")),
			continuesBefore: it.first.isBefore(from),
			continuesAfter: it.last.isAfter(to),
		}))
		.sort(
			(a, b) =>
				KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
				a.c0 - b.c0 ||
				b.c1 - b.c0 - (a.c1 - a.c0) ||
				a.at - b.at,
		);
	const lanes = [];
	for (const it of placed) {
		let lane = lanes.findIndex((row) =>
			row.every((o) => o.c1 < it.c0 || o.c0 > it.c1),
		);
		if (lane === -1) {
			lane = lanes.length;
			lanes.push([]);
		}
		lanes[lane].push(it);
		it.lane = lane;
	}
	return { chips: placed, laneCount: lanes.length };
};

function EventChip({ chip, onEventClick, style }) {
	const { ev } = chip;
	const color = eventColor(ev);
	const edges = `${chip.continuesBefore ? " cont-before" : ""}${chip.continuesAfter ? " cont-after" : ""}`;
	if (chip.kind === "bar") {
		return (
			<button
				type="button"
				className={`cal-chip cal-chip--bar${edges}`}
				style={{ ...style, background: color }}
				onClick={() => onEventClick(ev)}
				title={ev.title}
			>
				<span className="cal-chip-label">{ev.title}</span>
			</button>
		);
	}
	return (
		<button
			type="button"
			className="cal-chip cal-chip--timed"
			style={style}
			onClick={() => onEventClick(ev)}
			title={`${formatTime(chip.start.toISOString())} ${ev.title}`}
		>
			<span className="cal-chip-mark" style={{ background: color }} />
			<span className="cal-chip-time">
				{formatTime(chip.start.toISOString())}
			</span>
			<span className="cal-chip-label">{ev.title}</span>
		</button>
	);
}

function TaskChip({ chip, onOpen, onToggle, style }) {
	return (
		<div
			className={`cal-chip cal-chip--task${chip.done ? " is-done" : ""}${chip.overdue ? " is-overdue" : ""}${chip.recurring ? " is-recurring" : ""}`}
			style={style}
		>
			<button
				type="button"
				className="cal-check"
				aria-pressed={chip.done}
				aria-label={chip.done ? "Mark incomplete" : "Mark complete"}
				onClick={onToggle}
			>
				{chip.done ? "☑" : "☐"}
			</button>
			<button
				type="button"
				className="cal-pill-open"
				onClick={onOpen}
				title={`${chip.title}${chip.recurring ? " (recurring)" : " (due)"}`}
			>
				<span className="cal-chip-label">{chip.title}</span>
			</button>
		</div>
	);
}

/**
 * One month rendered as a block: a month label, then weeks of seven day cells.
 * Each week is a 7-column grid — the day cells fill every row as the clickable
 * background, and the chips sit on top in lanes, a multi-day event as one bar
 * across the days it spans (the same layout as the Android Calendar widget).
 * Days outside this month render as blank padding so each month is
 * self-contained in the continuous scroll.
 *
 * `items` are the window's chips, already filtered and expanded by the parent:
 * { kind: "bar" | "timed" | "task", first, last (local days), at, ... }.
 */
const MonthBlock = forwardRef(function MonthBlock(
	{
		month,
		items,
		onEventClick,
		onDayClick,
		onDeadlineClick,
		onOccurrenceClick,
		onToggleDeadline,
		onToggleOccurrence,
	},
	ref,
) {
	const today = KEY(dayjs());
	const weeks = buildWeeks(month);

	return (
		<section
			className="cal-month"
			data-label={month.format("MMMM YYYY")}
			ref={ref}
		>
			<h2 className="cal-month-label">{month.format("MMMM YYYY")}</h2>

			{weeks.map((week) => {
				const { chips, laneCount } = layoutWeek(items, week, month);
				return (
					<div
						key={KEY(week[0])}
						className="cal-week"
						style={{
							gridTemplateRows: `var(--cal-num-h) repeat(${laneCount}, var(--cal-lane-h)) 1fr`,
						}}
					>
						{week.map((day, i) => {
							const k = KEY(day);
							const place = { gridColumn: i + 1, gridRow: "1 / -1" };
							if (day.month() !== month.month()) {
								return (
									<div key={k} className="cal-cell is-empty" style={place} />
								);
							}
							return (
								<div
									key={k}
									className={`cal-cell${k === today ? " is-today" : ""}`}
									style={place}
								>
									{/* The day number is the "add event" button; its ::after
									    stretches over the whole cell so clicking empty space
									    still opens the day. Chips sit above it. */}
									<button
										type="button"
										className="cal-daynum"
										aria-label={`Add event on ${formatDate(day.toDate())}`}
										onClick={() => onDayClick(day)}
									>
										{day.date()}
									</button>
								</div>
							);
						})}

						{chips.map((chip) => {
							const style = {
								gridColumn: `${chip.c0 + 1} / ${chip.c1 + 2}`,
								gridRow: chip.lane + 2,
							};
							if (chip.kind !== "task") {
								return (
									<EventChip
										key={chip.key}
										chip={chip}
										style={style}
										onEventClick={onEventClick}
									/>
								);
							}
							return chip.recurring ? (
								<TaskChip
									key={chip.key}
									chip={chip}
									style={style}
									onOpen={() => onOccurrenceClick(chip.occurrence)}
									onToggle={() => onToggleOccurrence(chip.occurrence)}
								/>
							) : (
								<TaskChip
									key={chip.key}
									chip={chip}
									style={style}
									onOpen={() => onDeadlineClick(chip.task)}
									onToggle={() => onToggleDeadline(chip.task)}
								/>
							);
						})}
					</div>
				);
			})}
		</section>
	);
});

export default MonthBlock;
