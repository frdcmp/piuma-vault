import { useState } from "react";
import { useCreateTask, useDeleteTask, useUpdateTask } from "../../../queries";
import AlertsField from "../../components/AlertsField";
import {
	PvButton,
	PvDateTimePicker,
	PvModal,
} from "../../components/ui";

/**
 * Create / edit / delete a one-off task. Dates stored as UTC ISO.
 * `defaultTags` seeds the tags field on creation (e.g. the tag the list is
 * currently filtered by), so new tasks land in the group you're looking at.
 */
export default function TaskModal({ task, defaultTags = [], onClose }) {
	const isEdit = !!task;
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const deleteTask = useDeleteTask();

	const [title, setTitle] = useState(task?.title ?? "");
	const [notes, setNotes] = useState(task?.notes ?? "");
	const [dueAt, setDueAt] = useState(task?.due_at ?? null);
	const [priority, setPriority] = useState(task?.priority ?? 0);
	const [tags, setTags] = useState((task?.tags ?? defaultTags).join(", "));
	const [alerts, setAlerts] = useState(task?.alerts ?? []);
	const [error, setError] = useState("");

	const busy = createTask.isPending || updateTask.isPending;

	const handleConfirm = () => {
		if (!title.trim()) {
			setError("Title is required");
			return;
		}
		// Alerts fire relative to the due date, so they need one as an anchor.
		if (alerts.length > 0 && !dueAt) {
			setError("Set a due date to use alerts");
			return;
		}
		const tagList = tags
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		const payload = {
			title: title.trim(),
			notes: notes.trim() || null,
			due_at: dueAt || null,
			priority: Number(priority),
			tags: tagList,
			alerts,
		};
		const onDone = {
			onSuccess: onClose,
			onError: () => setError("Save failed"),
		};
		if (isEdit) updateTask.mutate({ id: task.id, ...payload }, onDone);
		else createTask.mutate(payload, onDone);
	};

	return (
		<PvModal
			open
			title={isEdit ? "Edit task" : "New task"}
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
						placeholder="What needs doing?"
						// biome-ignore lint/a11y/noAutofocus: modal entry field
						autoFocus
					/>
				</label>
				<div className="tasks-field">
					<span>Due</span>
					<PvDateTimePicker
						value={dueAt}
						onChange={(v) => {
							setDueAt(v);
							// Alerts are anchored to the due date — drop them if it's cleared.
							if (!v) setAlerts([]);
						}}
						mode="datetime"
						placeholder="No due date"
					/>
				</div>
				<label className="tasks-field">
					<span>Priority</span>
					<select
						value={priority}
						onChange={(e) => setPriority(e.target.value)}
					>
						<option value={0}>none</option>
						<option value={1}>low</option>
						<option value={2}>medium</option>
						<option value={3}>high</option>
					</select>
				</label>
				<label className="tasks-field">
					<span>Tags (comma-separated)</span>
					<input
						value={tags}
						onChange={(e) => setTags(e.target.value)}
						placeholder="fitness, admin"
					/>
				</label>
				<label className="tasks-field">
					<span>Notes</span>
					<textarea
						rows={3}
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
					/>
				</label>
				<div className="tasks-field">
					<span>Alerts</span>
					{dueAt ? (
						<AlertsField value={alerts} onChange={setAlerts} />
					) : (
						<p className="tasks-hint">Set a due date to add alerts.</p>
					)}
				</div>
				{error ? <p className="tasks-error">{error}</p> : null}
				{isEdit ? (
					<PvButton
						variant="danger"
						onClick={() => deleteTask.mutate(task.id, { onSuccess: onClose })}
					>
						Delete task
					</PvButton>
				) : null}
			</div>
		</PvModal>
	);
}
