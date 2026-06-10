import dayjs from "dayjs";
import { useState } from "react";
import { TagPicker } from "../../../components/buckets";
import {
	useCreateEvent,
	useDeleteEvent,
	useUpdateEvent,
} from "../../../queries";
import AlertsField from "../../components/AlertsField";
import {
	PvButton,
	PvDateTimePicker,
	PvModal,
} from "../../components/ui";

/**
 * Create / edit / delete a calendar event. `event` set → edit mode; otherwise
 * create, pre-filled at `initialDate` (a dayjs) at the next round hour.
 * Date/time state is stored as UTC ISO (PvDateTimePicker handles local I/O).
 */
export default function EventModal({ event, initialDate, onClose }) {
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
	const [color, setColor] = useState(event?.color ?? "#6cb6ff");
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
				<label className="cal-field">
					<span>Title</span>
					<input
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Event title"
						// biome-ignore lint/a11y/noAutofocus: modal entry field
						autoFocus
					/>
				</label>

				<label className="cal-field cal-field--inline">
					<input
						type="checkbox"
						checked={allDay}
						onChange={(e) => setAllDay(e.target.checked)}
					/>
					<span>All day</span>
				</label>

				<div className="cal-field">
					<span>Starts</span>
					<PvDateTimePicker
						value={startsAt}
						onChange={setStartsAt}
						mode={allDay ? "date" : "datetime"}
						clearable={false}
						placeholder="Pick start"
					/>
				</div>

				<div className="cal-field">
					<span>Ends</span>
					<PvDateTimePicker
						value={endsAt}
						onChange={setEndsAt}
						mode={allDay ? "date" : "datetime"}
						placeholder="Optional"
					/>
				</div>

				<label className="cal-field">
					<span>Location</span>
					<input
						value={location}
						onChange={(e) => setLocation(e.target.value)}
						placeholder="Optional"
					/>
				</label>

				<label className="cal-field">
					<span>Color</span>
					<input
						type="color"
						value={color}
						onChange={(e) => setColor(e.target.value)}
					/>
				</label>

				<div className="cal-field">
					<span>Tags</span>
					<TagPicker value={tags} onChange={setTags} />
				</div>

				<label className="cal-field cal-field--notes">
					<span>Notes</span>
					<textarea
						rows={3}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Optional"
					/>
				</label>

				<div className="cal-field">
					<span>Alerts</span>
					<AlertsField value={alerts} onChange={setAlerts} />
				</div>

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
