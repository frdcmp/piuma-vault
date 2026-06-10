import dayjs from "dayjs";

// Date labels for widgets. Hermes (RN's engine) ships no Intl.RelativeTimeFormat
// on Android, so we format with dayjs only — never Intl/toLocale*. Week math is
// Monday-first via the global dayjsConfig.

// Short "when" label for a task: "Overdue", "Today 14:30", "Tomorrow", "Thu",
// or "Jun 14". `withTime` is used for one-off tasks that carry a clock time;
// recurring occurrences are date-only.
export function taskWhenLabel(task) {
	const value = task.due_at || task.occurrence_date;
	if (!value) return "";
	if (task.overdue) {
		// Overdue one-off tasks keep their time so you can see how late.
		return task.due_at ? `Overdue · ${dayjs(value).format("MMM D")}` : "Overdue";
	}
	return dayLabel(value, { withTime: Boolean(task.due_at) });
}

// "When" label for an event: all-day events show just the day; timed events
// show the start time too.
export function eventWhenLabel(event) {
	return dayLabel(event.starts_at, { withTime: !event.all_day });
}

function dayLabel(value, { withTime = false } = {}) {
	const d = dayjs(value);
	const diff = d.startOf("day").diff(dayjs().startOf("day"), "day");
	let day;
	if (diff < 0) day = d.format("MMM D");
	else if (diff === 0) day = "Today";
	else if (diff === 1) day = "Tomorrow";
	else if (diff < 7) day = d.format("ddd");
	else day = d.format("MMM D");
	return withTime ? `${day} ${d.format("HH:mm")}` : day;
}
