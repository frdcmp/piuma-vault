import { useState } from "react";
import "./AlertsField.css";

// Preset reminder offsets (minutes before the anchor). 0 = fire exactly at start.
const PRESETS = [
	{ minutes: 0, label: "At start" },
	{ minutes: 10, label: "10m" },
	{ minutes: 30, label: "30m" },
	{ minutes: 60, label: "1h" },
	{ minutes: 1440, label: "1d" },
];

const UNITS = [
	{ value: "minutes", label: "min", factor: 1 },
	{ value: "hours", label: "hours", factor: 60 },
	{ value: "days", label: "days", factor: 1440 },
];

// Human label for any offset (incl. arbitrary custom values).
export function formatOffset(mins) {
	if (mins <= 0) return "At start";
	if (mins % 1440 === 0) {
		const d = mins / 1440;
		return `${d} day${d === 1 ? "" : "s"} before`;
	}
	if (mins % 60 === 0) {
		const h = mins / 60;
		return `${h} hour${h === 1 ? "" : "s"} before`;
	}
	return `${mins} min before`;
}

/**
 * Alerts editor — a list of reminder offsets (minutes before the event/task
 * anchor). `value` is the alerts array stored on the entity
 * (`[{ offset_minutes, channels? }]`); `onChange` receives the next array.
 * Channel selection follows the user's global Profile preferences, so we only
 * edit offsets here and preserve any existing `channels` on round-trip.
 */
export default function AlertsField({ value = [], onChange }) {
	const [customN, setCustomN] = useState(15);
	const [customUnit, setCustomUnit] = useState("minutes");

	const offsets = new Set(value.map((a) => a.offset_minutes));

	const sorted = [...value].sort((a, b) => a.offset_minutes - b.offset_minutes);

	const addOffset = (mins) => {
		if (offsets.has(mins)) return;
		onChange([...value, { offset_minutes: mins }]);
	};

	const removeOffset = (mins) => {
		onChange(value.filter((a) => a.offset_minutes !== mins));
	};

	const toggleOffset = (mins) => {
		if (offsets.has(mins)) removeOffset(mins);
		else addOffset(mins);
	};

	const addCustom = () => {
		const factor = UNITS.find((u) => u.value === customUnit)?.factor ?? 1;
		const mins = Math.max(0, Math.round(Number(customN) * factor));
		if (Number.isNaN(mins)) return;
		addOffset(mins);
	};

	return (
		<div className="alerts-field">
			<div className="alerts-presets">
				{PRESETS.map((p) => (
					<button
						type="button"
						key={p.minutes}
						className={`alerts-chip${offsets.has(p.minutes) ? " is-on" : ""}`}
						onClick={() => toggleOffset(p.minutes)}
					>
						{p.label}
					</button>
				))}
			</div>

			<div className="alerts-custom">
				<input
					type="number"
					min={0}
					value={customN}
					onChange={(e) => setCustomN(e.target.value)}
					aria-label="Custom reminder amount"
				/>
				<select
					value={customUnit}
					onChange={(e) => setCustomUnit(e.target.value)}
					aria-label="Custom reminder unit"
				>
					{UNITS.map((u) => (
						<option key={u.value} value={u.value}>
							{u.label}
						</option>
					))}
				</select>
				<button type="button" className="alerts-add" onClick={addCustom}>
					+ Add
				</button>
			</div>

			{sorted.length ? (
				<ul className="alerts-list">
					{sorted.map((a) => (
						<li key={a.offset_minutes} className="alerts-tag">
							<span>🔔 {formatOffset(a.offset_minutes)}</span>
							<button
								type="button"
								onClick={() => removeOffset(a.offset_minutes)}
								aria-label={`Remove ${formatOffset(a.offset_minutes)} reminder`}
							>
								×
							</button>
						</li>
					))}
				</ul>
			) : (
				<p className="alerts-empty">No alerts</p>
			)}
		</div>
	);
}
