import dayjs from "dayjs";
import { formatTime } from "../../../utils/dateTime";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Presentational month grid. All bucketing/timezone work happens in the parent;
 * this renders day cells with event / deadline / recurring-occurrence pills.
 */
export default function MonthGrid({
	weeks,
	month,
	byDay,
	keyOf,
	onEventClick,
	onDayClick,
	onToggleDeadline,
	onToggleOccurrence,
}) {
	const today = dayjs().format("YYYY-MM-DD");

	return (
		<div className="cal-grid">
			<div className="cal-weekdays">
				{WEEKDAYS.map((w) => (
					<div key={w} className="cal-weekday">
						{w}
					</div>
				))}
			</div>

			{weeks.map((week) => (
				<div key={keyOf(week[0])} className="cal-week">
					{week.map((day) => {
						const k = keyOf(day);
						const cell = byDay.get(k) || {
							events: [],
							deadlines: [],
							occurrences: [],
						};
						const isOtherMonth = day.month() !== month;
						const isToday = k === today;
						return (
							<button
								type="button"
								key={k}
								className={`cal-cell${isOtherMonth ? " is-other" : ""}${
									isToday ? " is-today" : ""
								}`}
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
		</div>
	);
}
