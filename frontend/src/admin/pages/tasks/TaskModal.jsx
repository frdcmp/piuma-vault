import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
	PvButton,
	PvDateTimePicker,
	PvField,
	PvInput,
	PvModal,
	PvSelect,
	PvTextarea,
} from "@/ui";
import { BucketSelect, TagPicker } from "../../../components/buckets";
import {
	useBuckets,
	useCreateTask,
	useDeleteTask,
	useUpdateTask,
} from "../../../queries";
import { formatDateTime } from "../../../utils/dateTime";
import { remarkPlugins } from "../../../utils/markdown";
import AlertsField from "../../components/AlertsField";

const PRIORITY_LABELS = ["none", "low", "medium", "high"];
const PRIORITY_OPTIONS = PRIORITY_LABELS.map((label, value) => ({
	value,
	label,
}));

/**
 * Task modal. Opening an existing task shows a read-only detail VIEW where each
 * field is click-to-edit and auto-saves on blur/change (no Save button) — so a
 * chat/agenda link that opens a task feels like viewing it, not a form.
 * Creating a new task keeps a plain form with an explicit Save (there's nothing
 * to auto-save into until it exists). Dates stored as UTC ISO. `defaultTags` /
 * `defaultBucket` seed the create form from the current filter.
 */
export default function TaskModal({
	task,
	defaultTags = [],
	defaultBucket = null,
	newRank = null,
	onClose,
}) {
	const isEdit = !!task;
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const deleteTask = useDeleteTask();
	const { data: buckets = [] } = useBuckets();

	const [title, setTitle] = useState(task?.title ?? "");
	const [notes, setNotes] = useState(task?.notes ?? "");
	const [dueAt, setDueAt] = useState(task?.due_at ?? null);
	const [priority, setPriority] = useState(task?.priority ?? 0);
	const [bucketId, setBucketId] = useState(
		task?.bucket_id ?? defaultBucket ?? "",
	);
	const [tags, setTags] = useState(task?.tags ?? defaultTags);
	const [alerts, setAlerts] = useState(task?.alerts ?? []);
	const [done, setDone] = useState(task?.done ?? false);
	const [error, setError] = useState("");

	// View-mode inline editing: which field is currently being edited, plus the
	// last-persisted title/notes (to revert an empty title and skip no-op saves).
	const [editing, setEditing] = useState(null);
	const saved = useRef({ title: task?.title ?? "", notes: task?.notes ?? "" });

	const busy = createTask.isPending || updateTask.isPending;

	// ── Create flow (explicit Save) ──────────────────────────────────────────
	const handleConfirm = () => {
		if (!title.trim()) {
			setError("Title is required");
			return;
		}
		if (alerts.length > 0 && !dueAt) {
			setError("Set a due date to use alerts");
			return;
		}
		createTask.mutate(
			{
				title: title.trim(),
				notes: notes.trim() || null,
				due_at: dueAt || null,
				priority: Number(priority),
				bucket_id: bucketId || null,
				tags,
				alerts,
				done,
				rank: newRank,
			},
			{ onSuccess: onClose, onError: () => setError("Save failed") },
		);
	};

	// ── View flow (inline edit, auto-save) ───────────────────────────────────
	const patch = (p) =>
		updateTask.mutate(
			{ id: task.id, ...p },
			{ onError: () => setError("Save failed") },
		);
	const edit = (field) => {
		setError("");
		setEditing(field);
	};
	// Close the inline editor when focus leaves its wrapper (for the composite
	// controls — bucket / tags / alerts — that don't commit on a single change).
	const closeOnLeave = (e) => {
		if (!e.currentTarget.contains(e.relatedTarget)) setEditing(null);
	};
	const commitTitle = () => {
		setEditing(null);
		const v = title.trim();
		if (!v) {
			setTitle(saved.current.title); // never let a task lose its title
			return;
		}
		if (v !== saved.current.title) {
			saved.current.title = v;
			setTitle(v);
			patch({ title: v });
		}
	};
	const titleKey = (e) => {
		e.stopPropagation(); // keep Enter/Escape from reaching the modal
		if (e.key === "Enter") {
			e.preventDefault();
			e.currentTarget.blur();
		} else if (e.key === "Escape") {
			e.preventDefault();
			setTitle(saved.current.title);
			setEditing(null);
		}
	};
	const commitNotes = () => {
		setEditing(null);
		if (notes !== saved.current.notes) {
			saved.current.notes = notes;
			patch({ notes: notes.trim() || null });
		}
	};
	const notesKey = (e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			e.preventDefault();
			setNotes(saved.current.notes);
			setEditing(null);
		}
	};
	const toggleDone = () => {
		const v = !done;
		setDone(v);
		patch({ done: v });
	};

	const bucket = buckets.find((b) => b.id === bucketId) || null;
	const dueLabel = dueAt
		? (() => {
				const { date, time } = formatDateTime(dueAt);
				return `${date} · ${time}`;
			})()
		: null;

	// ── Create form ──────────────────────────────────────────────────────────
	const createForm = (
		<div className="tasks-form">
			<PvField label="Title">
				<PvInput
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="What needs doing?"
					autoFocus
				/>
			</PvField>
			<PvField as="div" label="Due">
				<PvDateTimePicker
					value={dueAt}
					onChange={(v) => {
						setDueAt(v);
						if (!v) setAlerts([]);
					}}
					mode="datetime"
					placeholder="No due date"
				/>
			</PvField>
			<PvField label="Priority">
				<PvSelect
					options={PRIORITY_OPTIONS}
					value={priority}
					onChange={setPriority}
				/>
			</PvField>
			<PvField as="div" label="Bucket">
				<BucketSelect
					value={bucketId}
					onChange={setBucketId}
					buckets={buckets}
				/>
			</PvField>
			<PvField as="div" label="Tags">
				<TagPicker value={tags} onChange={setTags} />
			</PvField>
			<PvField label="Notes">
				<PvTextarea
					autoSize
					className="tasks-textarea-auto"
					rows={3}
					value={notes}
					onChange={(e) => setNotes(e.target.value)}
				/>
			</PvField>
			<PvField as="div" label="Alerts">
				{dueAt ? (
					<AlertsField value={alerts} onChange={setAlerts} />
				) : (
					<p className="tasks-hint">Set a due date to add alerts.</p>
				)}
			</PvField>
			{error ? <p className="tasks-error">{error}</p> : null}
		</div>
	);

	// ── View (inline edit) ─────────────────────────────────────────────────────
	const view = (
		<div className="tasks-form task-view">
			<PvButton
				variant={done ? "primary" : "default"}
				size="sm"
				className="task-done-toggle"
				icon={done ? "☑" : "☐"}
				aria-pressed={done}
				onClick={toggleDone}
			>
				{done ? "Completed" : "Mark complete"}
			</PvButton>

			{editing === "title" ? (
				<PvInput
					className="task-view-title-input"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={commitTitle}
					onKeyDown={titleKey}
					autoFocus
				/>
			) : (
				<button
					type="button"
					className={`task-view-title${done ? " is-done" : ""}`}
					onClick={() => edit("title")}
				>
					{title || "Untitled"}
				</button>
			)}

			<div className="task-view-meta">
				{/* Due */}
				<div className="task-view-row">
					<span className="task-view-label">Due</span>
					{editing === "due" ? (
						// biome-ignore lint/a11y/noStaticElementInteractions: focus-out wrapper closes the inline editor when focus leaves
						<div className="task-view-edit" onBlur={closeOnLeave}>
							<PvDateTimePicker
								value={dueAt}
								mode="datetime"
								placeholder="No due date"
								onChange={(v) => {
									setDueAt(v);
									const p = { due_at: v || null };
									if (!v) {
										setAlerts([]);
										p.alerts = [];
									}
									patch(p);
									setEditing(null);
								}}
							/>
						</div>
					) : (
						<button
							type="button"
							className="task-view-value"
							onClick={() => edit("due")}
						>
							{dueLabel || <span className="task-view-empty">No due date</span>}
						</button>
					)}
				</div>

				{/* Priority */}
				<div className="task-view-row">
					<span className="task-view-label">Priority</span>
					{editing === "priority" ? (
						<PvSelect
							className="task-view-select"
							options={PRIORITY_OPTIONS}
							value={priority}
							onChange={(v) => {
								setPriority(v);
								patch({ priority: v });
								setEditing(null);
							}}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									setEditing(null);
								}
							}}
							onBlur={() => setEditing(null)}
							autoFocus
						/>
					) : (
						<button
							type="button"
							className="task-view-value"
							onClick={() => edit("priority")}
						>
							<span
								className={`prio-dot prio-${priority}`}
								aria-hidden="true"
							/>
							{PRIORITY_LABELS[priority]}
						</button>
					)}
				</div>

				{/* Bucket */}
				<div className="task-view-row">
					<span className="task-view-label">Bucket</span>
					{editing === "bucket" ? (
						// biome-ignore lint/a11y/noStaticElementInteractions: focus-out wrapper closes the inline editor when focus leaves
						<div className="task-view-edit" onBlur={closeOnLeave}>
							<BucketSelect
								value={bucketId}
								buckets={buckets}
								onChange={(v) => {
									setBucketId(v);
									patch({ bucket_id: v || null });
									setEditing(null);
								}}
							/>
						</div>
					) : (
						<button
							type="button"
							className="task-view-value"
							onClick={() => edit("bucket")}
						>
							{bucket ? (
								<>
									<span
										className="bucket-dot"
										style={{ background: bucket.color || "var(--vp-muted)" }}
										aria-hidden="true"
									/>
									{bucket.name}
								</>
							) : (
								<span className="task-view-empty">No bucket</span>
							)}
						</button>
					)}
				</div>

				{/* Tags */}
				<div className="task-view-row task-view-row--top">
					<span className="task-view-label">Tags</span>
					{editing === "tags" ? (
						// biome-ignore lint/a11y/noStaticElementInteractions: focus-out wrapper closes the inline editor when focus leaves
						<div className="task-view-edit" onBlur={closeOnLeave}>
							<TagPicker
								value={tags}
								onChange={(arr) => {
									setTags(arr);
									patch({ tags: arr });
								}}
							/>
						</div>
					) : (
						<button
							type="button"
							className="task-view-value task-view-tags"
							onClick={() => edit("tags")}
						>
							{tags.length ? (
								tags.map((t) => (
									<span key={t} className="task-tag">
										#{t}
									</span>
								))
							) : (
								<span className="task-view-empty">No tags</span>
							)}
						</button>
					)}
				</div>

				{/* Alerts — only meaningful with a due date to anchor to */}
				{dueAt ? (
					<div className="task-view-row task-view-row--top">
						<span className="task-view-label">Alerts</span>
						{editing === "alerts" ? (
							// biome-ignore lint/a11y/noStaticElementInteractions: focus-out wrapper closes the inline editor when focus leaves
							<div className="task-view-edit" onBlur={closeOnLeave}>
								<AlertsField
									value={alerts}
									onChange={(a) => {
										setAlerts(a);
										patch({ alerts: a });
									}}
								/>
							</div>
						) : (
							<button
								type="button"
								className="task-view-value"
								onClick={() => edit("alerts")}
							>
								{alerts.length ? (
									`${alerts.length} reminder${alerts.length === 1 ? "" : "s"}`
								) : (
									<span className="task-view-empty">No alerts</span>
								)}
							</button>
						)}
					</div>
				) : null}
			</div>

			{/* Notes */}
			<div className="task-view-notes">
				<span className="task-view-label">Notes</span>
				{editing === "notes" ? (
					<PvTextarea
						autoSize
						className="tasks-textarea-auto"
						rows={3}
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
						onBlur={commitNotes}
						onKeyDown={notesKey}
						autoFocus
					/>
				) : (
					<button
						type="button"
						className="task-view-notes-display"
						onClick={() => edit("notes")}
					>
						{notes ? (
							<div className="task-view-md">
								<ReactMarkdown remarkPlugins={remarkPlugins}>
									{notes}
								</ReactMarkdown>
							</div>
						) : (
							<span className="task-view-empty">No notes — click to add</span>
						)}
					</button>
				)}
			</div>

			{error ? <p className="tasks-error">{error}</p> : null}

			<PvButton
				variant="danger"
				onClick={() => deleteTask.mutate(task.id, { onSuccess: onClose })}
			>
				Delete task
			</PvButton>
		</div>
	);

	return (
		<PvModal
			open
			title={isEdit ? "Task" : "New task"}
			className="task-modal"
			onCancel={onClose}
			cancelText={isEdit ? "Close" : "Cancel"}
			{...(isEdit
				? {}
				: { confirmText: busy ? "Saving…" : "Save", onConfirm: handleConfirm })}
		>
			{isEdit ? view : createForm}
		</PvModal>
	);
}
