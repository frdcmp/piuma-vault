import dayjs from "dayjs";
import { forwardRef } from "react";
import { formatTime } from "../../../utils/dateTime";

const EMPTY = { events: [], deadlines: [], occurrences: [] };

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

/**
 * One month rendered as a clean block (Airbnb-style): a month label, then weeks
 * of day cells. Days outside this month render as blank padding so each month is
 * self-contained in the continuous scroll. All bucketing/timezone work happens
 * in the parent; this only renders event / deadline / recurring pills.
 */
const MonthBlock = forwardRef(function MonthBlock(
	{
		month,
		byDay,
		keyOf,
		onEventClick,
		onDayClick,
		onToggleDeadline,
		onToggleOccurrence,
	},
	ref,
) {
	const today = dayjs().format("YYYY-MM-DD");
	const weeks = buildWeeks(month);

	return (
		<section
			className="cal-month"
			data-label={month.format("MMMM YYYY")}
			ref={ref}
		>
			<h2 className="cal-month-label">{month.format("MMMM YYYY")}</h2>

			{weeks.map((week) => (
				<div key={keyOf(week[0])} className="cal-week">
					{week.map((day) => {
						const k = keyOf(day);
						if (day.month() !== month.month()) {
							return <div key={k} className="cal-cell is-empty" />;
						}
						const cell = byDay.get(k) || EMPTY;
						const isToday = k === today;
						return (
							<button
								type="button"
								key={k}
								className={`cal-cell${isToday ? " is-today" : ""}`}
								onClick={() => onDayClick(day)}
							>
								<span className="cal-daynum">{day.date()}</span>

								{cell.events.map((ev) => (
									<button
										type="button"
										key={ev.id}
										className="cal-pill cal-pill--event"
										style={ev.color ? { borderLeftColor: ev.color } : undefined}
										onClick={(e) => {
											e.stopPropagation();
											onEventClick(ev);
										}}
										title={ev.title}
									>
										{!ev.all_day ? (
											<span className="cal-pill-time">
												{formatTime(ev.starts_at)}
											</span>
										) : null}
										<span className="cal-pill-label">{ev.title}</span>
									</button>
								))}

								{cell.occurrences.map((occ) => (
									<button
										type="button"
										key={`${occ.template.id}-${occ.date}`}
										className={`cal-pill cal-pill--task${occ.done ? " is-done" : ""}`}
										onClick={(e) => {
											e.stopPropagation();
											onToggleOccurrence(occ);
										}}
										title={`${occ.template.title} (recurring)`}
									>
										<span className="cal-check" aria-hidden="true">
											{occ.done ? "☑" : "☐"}
										</span>
										<span className="cal-pill-label">{occ.template.title}</span>
									</button>
								))}

								{cell.deadlines.map((t) => (
									<button
										type="button"
										key={t.id}
										className={`cal-pill cal-pill--task${t.done ? " is-done" : ""}`}
										onClick={(e) => {
											e.stopPropagation();
											onToggleDeadline(t);
										}}
										title={`${t.title} (due)`}
									>
										<span className="cal-check" aria-hidden="true">
											{t.done ? "☑" : "☐"}
										</span>
										<span className="cal-pill-label">{t.title}</span>
									</button>
								))}
							</button>
						);
					})}
				</div>
			))}
		</section>
	);
});

export default MonthBlock;
