import dayjs from "dayjs";
import { useState } from "react";
import {
	PvButton,
	PvCheckbox,
	PvDateTimePicker,
	PvField,
	PvInput,
	PvModal,
	PvSegmented,
	PvSelect,
} from "@/ui";
import { BucketSelect } from "../../../components/buckets";
import {
	useBuckets,
	useCreateRecurringTask,
	useDeleteRecurringTask,
	useUpdateRecurringTask,
} from "../../../queries";
import { parseRrule } from "../../../utils/recurrence";
import AlertsField from "../../components/AlertsField";

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
const DOW_OPTIONS = DOW.map((d) => ({ value: d, label: DOW_LABEL[d] }));
const FREQ_OPTIONS = [
	{ value: "DAILY", label: "daily" },
	{ value: "WEEKLY", label: "weekly" },
	{ value: "MONTHLY", label: "monthly" },
];
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
	const { data: buckets = [] } = useBuckets();

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
	const [bucketId, setBucketId] = useState(recurring?.bucket_id ?? "");
	const [tags, setTags] = useState((recurring?.tags ?? []).join(", "));
	const [alerts, setAlerts] = useState(recurring?.alerts ?? []);
	const [error, setError] = useState("");

	const busy = create.isPending || update.isPending;

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
			bucket_id: bucketId || null,
			tags: tags
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean),
			alerts,
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
			className="task-modal"
		>
			<div className="tasks-form">
				<PvField label="Title">
					<PvInput
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Leg day"
						autoFocus
					/>
				</PvField>

				<PvField label="Repeats">
					<PvSelect options={FREQ_OPTIONS} value={freq} onChange={setFreq} />
				</PvField>

				<PvField label="Every">
					<PvInput
						type="number"
						min={1}
						value={interval}
						onChange={(e) => setInterval(e.target.value)}
					/>
				</PvField>

				{freq === "WEEKLY" ? (
					<PvField as="div" label="On">
						<PvSegmented
							multiple
							size="sm"
							options={DOW_OPTIONS}
							value={byday}
							onChange={setByday}
						/>
					</PvField>
				) : null}

				<PvField as="div" label="Starts">
					<PvDateTimePicker
						value={dtstart}
						onChange={setDtstart}
						mode="datetime"
						clearable={false}
						placeholder="Pick start"
					/>
				</PvField>

				<PvField as="div" label="Until (optional)">
					<PvDateTimePicker
						value={until}
						onChange={setUntil}
						mode="date"
						placeholder="No end"
					/>
				</PvField>

				<PvField as="div" label="Bucket">
					<BucketSelect
						value={bucketId}
						onChange={setBucketId}
						buckets={buckets}
					/>
				</PvField>

				<PvField label="Tags">
					<PvInput
						value={tags}
						onChange={(e) => setTags(e.target.value)}
						placeholder="fitness"
					/>
				</PvField>

				<PvCheckbox checked={active} onChange={setActive} label="Active" />

				<PvField as="div" label="Alerts">
					<AlertsField value={alerts} onChange={setAlerts} />
				</PvField>

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
