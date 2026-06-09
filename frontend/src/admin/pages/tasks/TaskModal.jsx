import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import BucketSelect from "../../../components/BucketSelect";
import TagPicker from "../../../components/TagPicker";
import {
	useBuckets,
	useCreateTask,
	useDeleteTask,
	useUpdateTask,
} from "../../../queries";
import { formatDateTime } from "../../../utils/dateTime";
import AlertsField from "../../components/AlertsField";
import {
	PvButton,
	PvDateTimePicker,
	PvModal,
} from "../../components/ui";

const PRIORITY_LABELS = ["none", "low", "medium", "high"];

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

	// Grow the notes textarea to fit its content instead of clipping/scrolling.
	const notesRef = useRef(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `notes`/`editing` are the resize triggers, not read inside
	useEffect(() => {
		const el = notesRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [notes, editing]);

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
						if (!v) setAlerts([]);
					}}
					mode="datetime"
					placeholder="No due date"
				/>
			</div>
			<label className="tasks-field">
				<span>Priority</span>
				<select value={priority} onChange={(e) => setPriority(e.target.value)}>
					<option value={0}>none</option>
					<option value={1}>low</option>
					<option value={2}>medium</option>
					<option value={3}>high</option>
				</select>
			</label>
			<div className="tasks-field">
				<span>Bucket</span>
				<BucketSelect
					value={bucketId}
					onChange={setBucketId}
					buckets={buckets}
				/>
			</div>
			<div className="tasks-field">
				<span>Tags</span>
				<TagPicker value={tags} onChange={setTags} />
			</div>
			<label className="tasks-field">
				<span>Notes</span>
				<textarea
					ref={notesRef}
					className="tasks-textarea-auto"
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
		</div>
	);

	// ── View (inline edit) ─────────────────────────────────────────────────────
	const view = (
		<div className="tasks-form task-view">
			<button
				type="button"
				className={`task-done-toggle${done ? " is-done" : ""}`}
				aria-pressed={done}
				onClick={toggleDone}
			>
				<span className="task-done-box" aria-hidden="true">
					{done ? "☑" : "☐"}
				</span>
				{done ? "Completed" : "Mark complete"}
			</button>

			{editing === "title" ? (
				<input
					className="task-view-title-input"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={commitTitle}
					onKeyDown={titleKey}
					// biome-ignore lint/a11y/noAutofocus: entering inline edit
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
						<select
							className="task-view-select"
							value={priority}
							onChange={(e) => {
								const v = Number(e.target.value);
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
							// biome-ignore lint/a11y/noAutofocus: entering inline edit
							autoFocus
						>
							<option value={0}>none</option>
							<option value={1}>low</option>
							<option value={2}>medium</option>
							<option value={3}>high</option>
						</select>
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
										style={{ background: bucket.color || "var(--muted)" }}
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
					<textarea
						ref={notesRef}
						className="tasks-textarea-auto"
						rows={3}
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
						onBlur={commitNotes}
						onKeyDown={notesKey}
						// biome-ignore lint/a11y/noAutofocus: entering inline edit
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
								<ReactMarkdown remarkPlugins={[remarkGfm]}>
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
