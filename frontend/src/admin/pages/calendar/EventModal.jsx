import dayjs from "dayjs";
import { useState } from "react";
import { useTheme } from "@/theme";
import {
	PvButton,
	PvCheckbox,
	PvDateTimePicker,
	PvField,
	PvInput,
	PvModal,
	PvTextarea,
} from "@/ui";
import { TagPicker } from "../../../components/buckets";
import {
	useCreateEvent,
	useDeleteEvent,
	useUpdateEvent,
} from "../../../queries";
import AlertsField from "../../components/AlertsField";

/**
 * Create / edit / delete a calendar event. `event` set → edit mode; otherwise
 * create, pre-filled at `initialDate` (a dayjs) at the next round hour.
 * Date/time state is stored as UTC ISO (PvDateTimePicker handles local I/O).
 */
export default function EventModal({ event, initialDate, onClose }) {
	const { tokens } = useTheme();
	const isEdit = !!event;
	const createEvent = useCreateEvent();
	const updateEvent = useUpdateEvent();
	const deleteEvent = useDeleteEvent();

	const defaultStart = (initialDate || dayjs())
		.add(1, "hour")
		.minute(0)
		.second(0)
		.toISOString();

	const [title, setTitle] = useState(event?.title ?? "");
	const [allDay, setAllDay] = useState(event?.all_day ?? false);
	const [startsAt, setStartsAt] = useState(event?.starts_at ?? defaultStart);
	const [endsAt, setEndsAt] = useState(event?.ends_at ?? null);
	const [location, setLocation] = useState(event?.location ?? "");
	const [color, setColor] = useState(event?.color ?? tokens.info);
	const [description, setDescription] = useState(event?.description ?? "");
	const [tags, setTags] = useState(event?.tags ?? []);
	const [alerts, setAlerts] = useState(event?.alerts ?? []);
	const [error, setError] = useState("");

	const busy =
		createEvent.isPending || updateEvent.isPending || deleteEvent.isPending;

	const handleConfirm = () => {
		if (!title.trim()) {
			setError("Title is required");
			return;
		}
		const payload = {
			title: title.trim(),
			starts_at: startsAt,
			ends_at: endsAt || null,
			all_day: allDay,
			location: location.trim() || null,
			color,
			description: description.trim() || null,
			tags,
			alerts,
		};
		const onDone = {
			onSuccess: onClose,
			onError: () => setError("Save failed"),
		};
		if (isEdit) updateEvent.mutate({ id: event.id, ...payload }, onDone);
		else createEvent.mutate(payload, onDone);
	};

	const handleDelete = () => {
		deleteEvent.mutate(event.id, { onSuccess: onClose });
	};

	return (
		<PvModal
			open
			className="cal-event-modal"
			title={isEdit ? "Edit event" : "New event"}
			confirmText={busy ? "Saving…" : "Save"}
			cancelText="Cancel"
			onConfirm={handleConfirm}
			onCancel={onClose}
		>
			<div className="cal-form">
				<PvField label="Title">
					<PvInput
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Event title"
						autoFocus
					/>
				</PvField>

				<PvCheckbox checked={allDay} onChange={setAllDay} label="All day" />

				<PvField as="div" label="Starts">
					<PvDateTimePicker
						value={startsAt}
						onChange={setStartsAt}
						mode={allDay ? "date" : "datetime"}
						clearable={false}
						placeholder="Pick start"
					/>
				</PvField>

				<PvField as="div" label="Ends">
					<PvDateTimePicker
						value={endsAt}
						onChange={setEndsAt}
						mode={allDay ? "date" : "datetime"}
						placeholder="Optional"
					/>
				</PvField>

				<PvField label="Location">
					<PvInput
						value={location}
						onChange={(e) => setLocation(e.target.value)}
						placeholder="Optional"
					/>
				</PvField>

				<PvField label="Color">
					<input
						type="color"
						className="cal-color"
						value={color}
						onChange={(e) => setColor(e.target.value)}
					/>
				</PvField>

				<PvField as="div" label="Tags">
					<TagPicker value={tags} onChange={setTags} />
				</PvField>

				<PvField label="Notes" className="cal-field--notes">
					<PvTextarea
						rows={3}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Optional"
					/>
				</PvField>

				<PvField as="div" label="Alerts">
					<AlertsField value={alerts} onChange={setAlerts} />
				</PvField>

				{error ? <p className="cal-error">{error}</p> : null}

				{isEdit ? (
					<PvButton variant="danger" onClick={handleDelete} disabled={busy}>
						Delete event
					</PvButton>
				) : null}
			</div>
		</PvModal>
	);
}
