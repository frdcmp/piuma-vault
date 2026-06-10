import { useEffect, useState } from "react";
import { timeAgo } from "../../utils/dateTime";

/**
 * Renders a relative time (e.g. "6 minutes ago") that updates itself over time,
 * so a value stays accurate while the user just sits on the page.
 *
 * `timeAgo(value)` is pure and only recomputes on render — without this the
 * string freezes at first paint. All instances share ONE 30s interval (so a
 * long list doesn't spin up a timer per row); the timer only runs while at
 * least one <TimeAgo> is mounted.
 *
 * Returns a bare string, so it drops in anywhere `timeAgo(value)` was used:
 *   due <TimeAgo value={t.due_at} />
 */
const subscribers = new Set();
let timer = null;

function subscribe(cb) {
	subscribers.add(cb);
	if (timer === null) {
		timer = setInterval(() => {
			for (const fn of subscribers) fn();
		}, 30_000);
	}
	return () => {
		subscribers.delete(cb);
		if (subscribers.size === 0 && timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
}

export default function TimeAgo({ value }) {
	const [, tick] = useState(0);
	useEffect(() => subscribe(() => tick((n) => n + 1)), []);
	return timeAgo(value);
}
