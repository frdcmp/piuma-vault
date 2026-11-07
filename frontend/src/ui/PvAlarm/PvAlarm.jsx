import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatDate, formatTime } from "@/utils/dateTime";
import "./PvAlarm.css";

/**
 * The ringing alarm, must-dismiss, in the Pv look; the twin of the phone's
 * alarm screen: the time now, the bell ringing, what it's about, then Dismiss
 * (the main button) and the snooze choices as a row of buttons.
 *
 * Presentational + controlled: the parent owns timing/state and supplies the
 * copy plus the Snooze / Dismiss handlers. It portals to <body> and blocks the
 * page (no dismiss-on-click: an alarm must be acknowledged); Escape dismisses.
 *
 * Props:
 *   open          show/hide
 *   kind          the chip, e.g. "Task" | "Event" | "Recurring task"
 *   title         the headline (note/task title)
 *   timeText      the "due at …" / "Now — …" line
 *   body          optional extra body text
 *   snoozeOptions array of minute values, one button each
 *   onSnooze      (minutes) => void
 *   onDismiss     () => void
 */
export default function PvAlarm({
	open,
	kind = "Task",
	title,
	timeText,
	body,
	snoozeOptions = [5, 10, 15],
	onSnooze,
	onDismiss,
}) {
	const [now, setNow] = useState(() => new Date());

	// the clock, while it rings
	useEffect(() => {
		if (!open) return;
		setNow(new Date());
		const t = setInterval(() => setNow(new Date()), 5000);
		return () => clearInterval(t);
	}, [open]);

	// Escape dismisses, as the button
	useEffect(() => {
		if (!open) return;
		const onKey = (e) => e.key === "Escape" && onDismiss?.();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onDismiss]);

	if (!open) return null;

	return createPortal(
		<div className="pv-alarm-overlay" role="alertdialog" aria-modal="true">
			<div className="pv-alarm">
				<div className="pv-alarm-top">
					<span className="pv-alarm-app">Piuma</span>
					<span className="pv-alarm-kind">{kind}</span>
				</div>

				<div className="pv-alarm-clock">{formatTime(now)}</div>
				<div className="pv-alarm-date">{formatDate(now)}</div>

				<div className="pv-alarm-bell" aria-hidden="true">
					<span>🔔</span>
				</div>

				<h2 className="pv-alarm-title">{title}</h2>
				{timeText ? <p className="pv-alarm-time">{timeText}</p> : null}
				{body ? <p className="pv-alarm-text">{body}</p> : null}

				<div className="pv-alarm-actions">
					<button
						type="button"
						className="pv-alarm-btn is-main"
						onClick={onDismiss}
						// biome-ignore lint/a11y/noAutofocus: an alarm takes the focus, Enter stops it
						autoFocus
					>
						Dismiss
					</button>
					<div className="pv-alarm-snooze">
						<span className="pv-alarm-snooze-label">Snooze</span>
						{snoozeOptions.map((m) => (
							<button
								key={m}
								type="button"
								className="pv-alarm-btn"
								onClick={() => onSnooze?.(m)}
							>
								{m} min
							</button>
						))}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
