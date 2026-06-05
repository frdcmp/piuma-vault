import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./PvAlarm.css";

/**
 * Pixel-style, must-dismiss alarm dialog built entirely in CSS (no AntD).
 *
 * Presentational + controlled: the parent owns timing/state and supplies the
 * copy plus the Snooze / Dismiss handlers. It portals to <body>, blocks the
 * overlay (no dismiss-on-click — an alarm must be acknowledged), and renders a
 * blinking pixel bell. The Snooze button opens an inline menu of the provided
 * `snoozeOptions` (minutes).
 *
 * Props:
 *   open          show/hide
 *   kind          badge label, e.g. "Task" | "Event" | "Recurring task"
 *   title         the headline (note/task title)
 *   timeText      the "due at …" / "Now — …" line
 *   body          optional extra body text
 *   snoozeOptions array of minute values for the snooze menu
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
	const [snoozeMenu, setSnoozeMenu] = useState(false);

	// Close the snooze menu whenever the alarm changes/closes.
	useEffect(() => {
		setSnoozeMenu(false);
	}, []);

	if (!open) return null;

	return createPortal(
		<div className="pv-alarm-overlay" role="alertdialog" aria-modal="true">
			<div className="pv-alarm">
				<div className="pv-alarm-bar">
					<span className="pv-alarm-bell" aria-hidden="true">
						🔔
					</span>
					<span className="pv-alarm-bar-title">{kind} reminder</span>
					<span className="pv-alarm-badge">!</span>
				</div>

				<div className="pv-alarm-body">
					<h2 className="pv-alarm-title">{title}</h2>
					{timeText ? <p className="pv-alarm-time">{timeText}</p> : null}
					{body ? <p className="pv-alarm-text">{body}</p> : null}
				</div>

				<div className="pv-alarm-actions">
					<div className="pv-alarm-snooze-wrap">
						{snoozeMenu && (
							<div className="pv-alarm-snooze-menu" role="menu">
								{snoozeOptions.map((m) => (
									<button
										key={m}
										type="button"
										role="menuitem"
										className="pv-alarm-snooze-item"
										onClick={() => {
											setSnoozeMenu(false);
											onSnooze?.(m);
										}}
									>
										{m} min
									</button>
								))}
							</div>
						)}
						<button
							type="button"
							className="pv-alarm-btn"
							aria-haspopup="menu"
							aria-expanded={snoozeMenu}
							onClick={() => setSnoozeMenu((v) => !v)}
						>
							Snooze ▴
						</button>
					</div>
					<button
						type="button"
						className="pv-alarm-btn danger"
						onClick={onDismiss}
					>
						Dismiss
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
