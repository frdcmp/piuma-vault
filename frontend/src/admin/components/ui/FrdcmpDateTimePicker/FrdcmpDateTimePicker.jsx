import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, formatTime } from "../../../../utils/dateTime";
import "./PvDateTimePicker.css";

const WEEKDAYS = [
	{ id: "mo", label: "M" },
	{ id: "tu", label: "T" },
	{ id: "we", label: "W" },
	{ id: "th", label: "T" },
	{ id: "fr", label: "F" },
	{ id: "sa", label: "S" },
	{ id: "su", label: "S" },
];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5); // 5-min steps

/**
 * PvDateTimePicker — themed, self-contained date/time selector.
 *
 * Works in the user's LOCAL timezone for display/editing but accepts and emits
 * UTC ISO strings (matching the backend + the Calendar/Tasks timezone rule).
 *
 * Props:
 *   value       UTC ISO string | null      currently selected instant
 *   onChange    (utcIsoOrNull) => void      fires on every pick / clear
 *   mode        "datetime" | "date" | "time"  which parts to show (default datetime)
 *   placeholder string                      shown when value is empty
 *   clearable   boolean                     show the Clear action (default true)
 */
export default function PvDateTimePicker({
	value,
	onChange,
	mode = "datetime",
	placeholder = "Pick…",
	clearable = true,
}) {
	const showDate = mode === "datetime" || mode === "date";
	const showTime = mode === "datetime" || mode === "time";

	const [open, setOpen] = useState(false);
	const selected = useMemo(() => (value ? dayjs(value) : null), [value]);
	const [viewMonth, setViewMonth] = useState(() =>
		(selected || dayjs()).startOf("month"),
	);
	const wrapRef = useRef(null);

	// Close on outside click / Escape.
	useEffect(() => {
		if (!open) return;
		const onDown = (e) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target))
				setOpen(false);
		};
		const onKey = (e) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Emit a new value built from a base instant. Keeps the existing time when
	// only the date changes, and vice-versa.
	const emit = (next) => onChange?.(next ? next.toISOString() : null);

	const pickDay = (day) => {
		const base = selected || dayjs().hour(9).minute(0);
		const next = day
			.hour(showTime ? base.hour() : 0)
			.minute(showTime ? base.minute() : 0)
			.second(0);
		emit(next);
		if (mode === "date") setOpen(false);
	};

	const pickHour = (h) =>
		emit((selected || dayjs().minute(0)).hour(h).second(0));
	const pickMinute = (m) => emit((selected || dayjs()).minute(m).second(0));

	const label = (() => {
		if (!selected) return placeholder;
		if (mode === "date") return formatDate(value);
		if (mode === "time") return formatTime(value);
		const { date, time } = { date: formatDate(value), time: formatTime(value) };
		return `${date} · ${time}`;
	})();

	// Build the 6-week grid for the viewed month.
	const weeks = useMemo(() => {
		const start = viewMonth.startOf("month").startOf("week");
		const out = [];
		let d = start;
		for (let w = 0; w < 6; w++) {
			const row = [];
			for (let i = 0; i < 7; i++) {
				row.push(d);
				d = d.add(1, "day");
			}
			out.push(row);
		}
		return out;
	}, [viewMonth]);

	const todayKey = dayjs().format("YYYY-MM-DD");
	const selKey = selected?.format("YYYY-MM-DD");

	return (
		<div className="fdt" ref={wrapRef}>
			<button
				type="button"
				className={`fdt-field${selected ? "" : " is-empty"}`}
				onClick={() => setOpen((o) => !o)}
			>
				<span className="fdt-value">{label}</span>
				<span className="fdt-glyph" aria-hidden="true">
					{mode === "time" ? "🕘" : "▤"}
				</span>
			</button>

			{open ? (
				<div className="fdt-pop">
					{showDate ? (
						<div className="fdt-cal">
							<div className="fdt-cal-head">
								<button
									type="button"
									className="fdt-nav"
									onClick={() => setViewMonth((m) => m.subtract(1, "month"))}
									aria-label="Previous month"
								>
									‹
								</button>
								<span className="fdt-month">
									{viewMonth.format("MMMM YYYY")}
								</span>
								<button
									type="button"
									className="fdt-nav"
									onClick={() => setViewMonth((m) => m.add(1, "month"))}
									aria-label="Next month"
								>
									›
								</button>
							</div>
							<div className="fdt-weekdays">
								{WEEKDAYS.map((w) => (
									<span key={w.id} className="fdt-weekday">
										{w.label}
									</span>
								))}
							</div>
							{weeks.map((row) => (
								<div key={row[0].format("YYYY-MM-DD")} className="fdt-row">
									{row.map((day) => {
										const k = day.format("YYYY-MM-DD");
										return (
											<button
												type="button"
												key={k}
												className={`fdt-day${
													day.month() !== viewMonth.month() ? " is-other" : ""
												}${k === todayKey ? " is-today" : ""}${
													k === selKey ? " is-sel" : ""
												}`}
												onClick={() => pickDay(day)}
											>
												{day.date()}
											</button>
										);
									})}
								</div>
							))}
						</div>
					) : null}

					{showTime ? (
						<div className="fdt-time">
							<div className="fdt-timecol">
								{HOURS.map((h) => (
									<button
										type="button"
										key={h}
										className={`fdt-time-item${
											selected?.hour() === h ? " is-on" : ""
										}`}
										onClick={() => pickHour(h)}
									>
										{String(h).padStart(2, "0")}
									</button>
								))}
							</div>
							<span className="fdt-time-sep">:</span>
							<div className="fdt-timecol">
								{MINUTES.map((m) => (
									<button
										type="button"
										key={m}
										className={`fdt-time-item${
											selected && Math.floor(selected.minute() / 5) * 5 === m
												? " is-on"
												: ""
										}`}
										onClick={() => pickMinute(m)}
									>
										{String(m).padStart(2, "0")}
									</button>
								))}
							</div>
						</div>
					) : null}

					<div className="fdt-foot">
						{clearable ? (
							<button
								type="button"
								className="fdt-action"
								onClick={() => {
									emit(null);
									setOpen(false);
								}}
							>
								Clear
							</button>
						) : (
							<span />
						)}
						<button
							type="button"
							className="fdt-action fdt-action--now"
							onClick={() => {
								emit(dayjs());
								setViewMonth(dayjs().startOf("month"));
							}}
						>
							Now
						</button>
						<button
							type="button"
							className="fdt-action fdt-action--done"
							onClick={() => setOpen(false)}
						>
							Done
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
