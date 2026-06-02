import dayjs from "dayjs";
import { useState } from "react";
import {
	useCreateRecurringTask,
	useDeleteRecurringTask,
	useUpdateRecurringTask,
} from "../../../queries";
import { parseRrule } from "../../../utils/recurrence";
import {
	PvButton,
	PvDateTimePicker,
	PvModal,
} from "../../components/ui";

const DOW = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DOW_LABEL = {
	MO: "M",
	TU: "T",
	WE: "W",
	TH: "T",
	FR: "F",
	SA: "S",
	SU: "S",
};
const BYDAY_FROM_INDEX = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Build an rrule string from the simple builder state.
const buildRrule = (freq, interval, byday) => {
	const parts = [`FREQ=${freq}`];
	if (interval > 1) parts.push(`INTERVAL=${interval}`);
	if (freq === "WEEKLY" && byday.length) parts.push(`BYDAY=${byday.join(",")}`);
	return parts.join(";");
};

/**
 * Create / edit / delete a recurring-task template. A simple weekday picker
 * builds the rrule; expansion happens client-side in the user's local timezone.
 */
export default function RecurringTaskModal({ recurring, onClose }) {
	const isEdit = !!recurring;
	const create = useCreateRecurringTask();
	const update = useUpdateRecurringTask();
	const remove = useDeleteRecurringTask();

	const parsed = parseRrule(recurring?.rrule);
	const [title, setTitle] = useState(recurring?.title ?? "");
	const [freq, setFreq] = useState(parsed.freq ?? "WEEKLY");
	const [interval, setInterval] = useState(parsed.interval ?? 1);
	const [byday, setByday] = useState(
		parsed.byday.length
			? parsed.byday.map((i) => BYDAY_FROM_INDEX[i])
			: [
					DOW[dayjs(recurring?.dtstart).day() === 0 ? 6 : dayjs().day() - 1] ||
						"MO",
				],
	);
	const [dtstart, setDtstart] = useState(
		recurring?.dtstart ?? dayjs().hour(9).minute(0).second(0).toISOString(),
	);
	const [until, setUntil] = useState(recurring?.until ?? null);
	const [active, setActive] = useState(recurring?.active ?? true);
	const [tags, setTags] = useState((recurring?.tags ?? []).join(", "));
	const [error, setError] = useState("");

	const busy = create.isPending || update.isPending;

	const toggleDay = (d) =>
		setByday((prev) =>
			prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
		);

	const handleConfirm = () => {
		if (!title.trim()) {
			setError("Title is required");
			return;
		}
		if (freq === "WEEKLY" && byday.length === 0) {
			setError("Pick at least one weekday");
			return;
		}
		const payload = {
			title: title.trim(),
			rrule: buildRrule(freq, Number(interval), byday),
			dtstart,
			// Make `until` inclusive of the chosen day (picker emits local midnight).
			until: until ? dayjs(until).endOf("day").toISOString() : null,
			active,
			tags: tags
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean),
		};
		const onDone = {
			onSuccess: onClose,
			onError: () => setError("Save failed"),
		};
		if (isEdit) update.mutate({ id: recurring.id, ...payload }, onDone);
		else create.mutate(payload, onDone);
	};

	return (
		<PvModal
			open
			title={isEdit ? "Edit recurring task" : "New recurring task"}
			confirmText={busy ? "Saving…" : "Save"}
			onConfirm={handleConfirm}
			onCancel={onClose}
		>
			<div className="tasks-form">
				<label className="tasks-field">
					<span>Title</span>
					<input
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Leg day"
						// biome-ignore lint/a11y/noAutofocus: modal entry field
						autoFocus
					/>
				</label>

				<label className="tasks-field">
					<span>Repeats</span>
					<select value={freq} onChange={(e) => setFreq(e.target.value)}>
						<option value="DAILY">daily</option>
						<option value="WEEKLY">weekly</option>
						<option value="MONTHLY">monthly</option>
					</select>
				</label>

				<label className="tasks-field">
					<span>Every</span>
					<input
						type="number"
						min={1}
						value={interval}
						onChange={(e) => setInterval(e.target.value)}
					/>
				</label>

				{freq === "WEEKLY" ? (
					<div className="tasks-field">
						<span>On</span>
						<div className="dow-picker">
							{DOW.map((d) => (
								<button
									type="button"
									key={d}
									className={`dow-btn${byday.includes(d) ? " is-on" : ""}`}
									onClick={() => toggleDay(d)}
								>
									{DOW_LABEL[d]}
								</button>
							))}
						</div>
					</div>
				) : null}

				<div className="tasks-field">
					<span>Starts</span>
					<PvDateTimePicker
						value={dtstart}
						onChange={setDtstart}
						mode="datetime"
						clearable={false}
						placeholder="Pick start"
					/>
				</div>

				<div className="tasks-field">
					<span>Until (optional)</span>
					<PvDateTimePicker
						value={until}
						onChange={setUntil}
						mode="date"
						placeholder="No end"
					/>
				</div>

				<label className="tasks-field">
					<span>Tags</span>
					<input
						value={tags}
						onChange={(e) => setTags(e.target.value)}
						placeholder="fitness"
					/>
				</label>

				<label className="tasks-field tasks-field--inline">
					<input
						type="checkbox"
						checked={active}
						onChange={(e) => setActive(e.target.checked)}
					/>
					<span>Active</span>
				</label>

				<p className="tasks-hint">
					rule: <code>{buildRrule(freq, Number(interval), byday)}</code>
				</p>

				{error ? <p className="tasks-error">{error}</p> : null}
				{isEdit ? (
					<PvButton
						variant="danger"
						onClick={() => remove.mutate(recurring.id, { onSuccess: onClose })}
					>
						Delete recurring task
					</PvButton>
				) : null}
			</div>
		</PvModal>
	);
}
