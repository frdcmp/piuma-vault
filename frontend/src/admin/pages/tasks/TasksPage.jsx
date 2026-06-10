import { BellOutlined } from "@ant-design/icons";
import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	restrictToParentElement,
	restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import WorkspaceShell from "../../../chat/WorkspaceShell";
import BucketTagFilter from "../../../components/BucketTagFilter";
import ManageBucketsModal from "../../../components/ManageBucketsModal";
import TimeAgo from "../../../components/TimeAgo";
import UserMenu from "../../../components/UserMenu";
import {
	useBuckets,
	useDeleteRecurringTask,
	useRecurringTasks,
	useTagRegistry,
	useTagsLiveUpdates,
	useTask,
	useTasks,
	useTasksLiveUpdates,
	useToggleTask,
	useUpdateTask,
} from "../../../queries";
import { formatDate } from "../../../utils/dateTime";
import { rankBefore, rankBetween } from "../../../utils/rank";
import { tagColor } from "../../../utils/tagColor";
import { PvButton, pvMessage } from "../../components/ui";
import RecurringTaskModal from "./RecurringTaskModal";
import TaskModal from "./TaskModal";
import "./Tasks.css";

const PRIORITY = ["", "low", "med", "high"];
// Checkbox tint by priority: none → muted, low → green, med → yellow, high → red.
const PRIORITY_COLOR = [
	"var(--muted)",
	"var(--accent-2)",
	"var(--accent)",
	"var(--accent-3)",
];

const ALL = { key: "all", names: null, label: "All" };

// `alerts` arrives as a JSON array of { offset_minutes, channels? } objects.
const hasAlerts = (t) => Array.isArray(t.alerts) && t.alerts.length > 0;

// One pending task row, draggable via its handle (the rest of the row stays
// clickable: ☐ toggles, the body opens the modal, #tags filter).
function SortableTaskRow({
	t,
	bucket,
	toggling,
	onToggle,
	onOpen,
	onSelectTag,
	tagColorOf,
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: t.id });
	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};
	return (
		<li
			ref={setNodeRef}
			style={style}
			className={`task-row${t.priority ? ` prio-${t.priority}` : ""}${
				isDragging ? " is-dragging" : ""
			}`}
			title={t.priority ? `${PRIORITY[t.priority]} priority` : undefined}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				className="task-drag"
				aria-label="Drag to reorder"
				{...attributes}
				{...listeners}
			>
				⠿
			</button>
			<button
				type="button"
				className="task-check"
				style={{ color: PRIORITY_COLOR[t.priority] }}
				onClick={() => onToggle(t.id)}
				disabled={toggling}
				aria-label="Complete task"
			>
				{toggling ? <span className="task-spin" aria-hidden="true" /> : "☐"}
			</button>
			{bucket ? (
				<span
					className="task-bucket"
					style={{ color: bucket.color || undefined }}
				>
					{bucket.name}
				</span>
			) : null}
			<button type="button" className="task-main" onClick={() => onOpen(t)}>
				<span className="task-title">{t.title}</span>
				{t.due_at || hasAlerts(t) ? (
					<span className="task-meta">
						{t.due_at ? (
							<span className="task-due">
								due <TimeAgo value={t.due_at} />
							</span>
						) : null}
						{hasAlerts(t) ? (
							<BellOutlined
								className="task-alert"
								title="Has alerts set"
								aria-label="Has alerts set"
							/>
						) : null}
					</span>
				) : null}
			</button>
			{t.tags?.length ? (
				<span className="task-tags">
					{t.tags.map((tag) => (
						<button
							type="button"
							key={tag}
							className="task-tag"
							style={{ color: tagColorOf(tag) }}
							onClick={() => onSelectTag(tag)}
						>
							#{tag}
						</button>
					))}
				</span>
			) : null}
		</li>
	);
}

export default function TasksPage() {
	const navigate = useNavigate();
	useTasksLiveUpdates(); // refetch when tasks change in another tab/device
	useTagsLiveUpdates("tasks"); // keep the tag tree + counts fresh
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const { data: buckets = [] } = useBuckets();
	const { data: tagRegistry = [] } = useTagRegistry();
	const toggleTask = useToggleTask();
	const updateTask = useUpdateTask();
	const deleteRecurring = useDeleteRecurringTask();

	// Drag handle activates after a small move so a plain click still toggles /
	// opens the row; keyboard reordering for accessibility.
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const [taskModal, setTaskModal] = useState(null); // { task } | {} | null
	const [recModal, setRecModal] = useState(null);
	const [manageOpen, setManageOpen] = useState(false);
	// Bucket + tags filter independently and combine (AND). `bucketSel` is the
	// bucket constraint (all / nobucket / a specific bucket); `tags` is the set
	// of selected tag names — a task must match the bucket AND carry one of the
	// active tags. "all" acts as the master reset for both.
	const [bucketSel, setBucketSel] = useState(ALL); // { key, bucketId, label }
	const [tags, setTags] = useState([]); // active tag names
	const [showRecurring, setShowRecurring] = useState(false); // sidebar view toggle

	// Deep-link: /tasks?task=<id> opens that task's modal (e.g. from a chat link).
	// Prefer the already-loaded list; fall back to fetching by id. Clear the param
	// on close so it doesn't reopen; a missing id degrades to a toast.
	const [searchParams, setSearchParams] = useSearchParams();
	const deepTaskId = searchParams.get("task");
	const taskInList = deepTaskId ? tasks.find((t) => t.id === deepTaskId) : null;
	const { data: fetchedTask, error: taskErr } = useTask(
		taskInList ? null : deepTaskId,
	);
	const deepTask = taskInList || fetchedTask;
	const clearTaskParam = useCallback(() => {
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("task");
				return next;
			},
			{ replace: true },
		);
	}, [setSearchParams]);
	useEffect(() => {
		if (!(deepTaskId && deepTask)) return;
		setTaskModal({ task: deepTask });
		// Pre-filter the list to the task's bucket so it opens in context (the
		// to-do view, tag filter cleared, so the task is guaranteed visible).
		setShowRecurring(false);
		setTags([]);
		if (deepTask.bucket_id) {
			const b = buckets.find((x) => x.id === deepTask.bucket_id);
			setBucketSel(
				b ? { key: `bucket:${b.id}`, bucketId: b.id, label: b.name } : ALL,
			);
		} else {
			setBucketSel({ key: "nobucket", label: "no bucket" });
		}
	}, [deepTaskId, deepTask, buckets]);
	useEffect(() => {
		if (deepTaskId && taskErr) {
			pvMessage.error("That task couldn't be found.");
			clearTaskParam();
		}
	}, [deepTaskId, taskErr, clearTaskParam]);

	// Per-tag colour from the registry (falls back to the derived hue).
	const tagColorOf = (name) =>
		tagRegistry.find((r) => r.name === name)?.color || tagColor(name);

	// Bucket lookup for the per-task badge.
	const bucketById = new Map(buckets.map((b) => [b.id, b]));

	// One-off tasks only (materialized recurring occurrences are history, hidden here).
	const oneOff = tasks.filter((t) => !t.recurrence_id);

	// Apply the bucket constraint, then narrow by the active tags (a task matches
	// if it carries any of them). The two combine, so a bucket stays in effect
	// while you add tag filters on top.
	let visible = oneOff;
	if (bucketSel.key.startsWith("bucket:"))
		visible = visible.filter((t) => t.bucket_id === bucketSel.bucketId);
	else if (bucketSel.key === "nobucket")
		visible = visible.filter((t) => !t.bucket_id);
	if (tags.length)
		visible = visible.filter((t) => t.tags?.some((n) => tags.includes(n)));

	// The API returns tasks already in manual order (by `rank`); filtering keeps
	// that order. `serverPending` is the source of truth; `order` mirrors it but
	// holds the user's in-progress arrangement so a drag doesn't snap back while
	// the rank PUT round-trips.
	const serverPending = visible.filter((t) => !t.done);
	const done = visible.filter((t) => t.done);

	const byId = new Map(serverPending.map((t) => [t.id, t]));
	const [order, setOrder] = useState([]);
	// Re-sync to the server order only when the *set* of pending tasks changes
	// (add / remove / complete / filter switch) — not on reorder, so an
	// optimistic drag isn't clobbered by the refetch it triggers.
	const setSig = [...serverPending.map((t) => t.id)].sort().join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-sync keyed on the id-set, not order
	useEffect(() => {
		setOrder(serverPending.map((t) => t.id));
	}, [setSig]);

	const pending = order.map((id) => byId.get(id)).filter(Boolean);
	const pendingIds = pending.map((t) => t.id);

	const onDragEnd = ({ active, over }) => {
		if (!over || active.id === over.id) return;
		const from = pendingIds.indexOf(active.id);
		const to = pendingIds.indexOf(over.id);
		if (from < 0 || to < 0) return;
		const next = arrayMove(pendingIds, from, to);
		setOrder(next); // optimistic
		// Mint a key strictly between the new neighbours.
		const before = byId.get(next[to - 1])?.rank ?? null;
		const after = byId.get(next[to + 1])?.rank ?? null;
		updateTask.mutate({ id: active.id, rank: rankBetween(before, after) });
	};

	// The id of the task whose toggle is in flight, so we can spin just its box.
	const togglingId = toggleTask.isPending ? toggleTask.variables : null;

	// Only one tag filters at a time (kept as an array so it composes with the
	// bucket constraint). Clicking a tag on a task row selects it, keeping the
	// bucket; clicking the active tag again (in the sidebar) clears it.
	const selectTag = (tag) => {
		setShowRecurring(false);
		setTags([tag]);
	};

	const toggleTag = (tag) => {
		setShowRecurring(false);
		setTags((prev) => (prev.includes(tag) ? [] : [tag]));
	};

	const defaultTags = tags;
	const defaultBucket = bucketSel.key.startsWith("bucket:")
		? bucketSel.bucketId
		: null;

	// Tag section reflects the selected bucket: only tags used by tasks in that
	// bucket (or "no bucket"). Otherwise ("all") → all tags. Done tasks are
	// excluded so the list (and its counts) only shows tags with actual to-dos —
	// a tag whose tasks are all completed drops out.
	const tagScope = (
		bucketSel.key.startsWith("bucket:")
			? oneOff.filter((t) => t.bucket_id === bucketSel.bucketId)
			: bucketSel.key === "nobucket"
				? oneOff.filter((t) => !t.bucket_id)
				: oneOff
	).filter((t) => !t.done);

	// Heading reflects the combined filter, e.g. "keeperproxy + #admin".
	const filterLabel = [
		bucketSel.key !== "all" ? bucketSel.label : null,
		...tags.map((t) => `#${t}`),
	]
		.filter(Boolean)
		.join(" + ");

	return (
		<WorkspaceShell>
			<div className="tasks-page">
				<header className="tasks-header">
					<div className="tasks-title">
						<PvButton variant="ghost" onClick={() => navigate("/notes")}>
							‹ home
						</PvButton>
						<span className="tasks-glyph" aria-hidden="true">
							☑
						</span>
						<h1>Tasks</h1>
					</div>
					<div className="tasks-actions">
						<PvButton
							variant="ghost"
							onClick={() => navigate("/admin/calendar")}
						>
							calendar ▤
						</PvButton>
						<PvButton
							variant="accent"
							onClick={() =>
								setTaskModal({
									defaultTags,
									defaultBucket,
									// New tasks land at the top of the list.
									newRank: rankBefore(pending[0]?.rank),
								})
							}
						>
							+ task
						</PvButton>
						<UserMenu size={34} />
					</div>
				</header>

				<div className="tasks-body">
					{/* ── Bucket + tag filter ── */}
					<aside className="tasks-sidebar">
						<div className="tasks-sidebar-head">
							<h2 className="tasks-panel-title">Filter</h2>
							<button
								type="button"
								className="tasks-manage-btn"
								onClick={() => setManageOpen(true)}
							>
								⚙ manage
							</button>
						</div>
						<BucketTagFilter
							scope="tasks"
							items={oneOff}
							tagItems={tagScope}
							buckets={buckets}
							selectedKey={showRecurring ? null : bucketSel.key}
							activeTags={showRecurring ? [] : tags}
							onSelect={(s) => {
								setShowRecurring(false);
								if (s.key === "all") {
									// Master reset — clear both the bucket and tag filters.
									setBucketSel(ALL);
									setTags([]);
								} else if (
									s.key === "nobucket" ||
									s.key.startsWith("bucket:")
								) {
									// Switching bucket resets tags — the tag list is scoped to the
									// bucket, so stale tags may not exist in the new one.
									setBucketSel(s);
									setTags([]);
								} else if (s.names) {
									toggleTag(s.names[0]); // keep the bucket
								}
							}}
							totalCount={oneOff.length}
						/>

						<div className="tag-nav-divider" aria-hidden="true" />

						<ul className="tag-nav">
							<li>
								<button
									type="button"
									className={`tag-nav-btn${showRecurring ? " is-active" : ""}`}
									onClick={() => setShowRecurring(true)}
								>
									<span className="tag-nav-name">⟳ recurring</span>
									<span className="tag-nav-count">{recurring.length}</span>
								</button>
							</li>
						</ul>
					</aside>

					<div className="tasks-cols">
						{!showRecurring ? (
							<>
								{/* ── To-do ── */}
								<section className="tasks-panel">
									<h2 className="tasks-panel-title">
										{filterLabel ? `${filterLabel} · ` : "To do · "}
										{pending.length}
									</h2>
									<DndContext
										sensors={sensors}
										collisionDetection={closestCenter}
										modifiers={[
											restrictToVerticalAxis,
											restrictToParentElement,
										]}
										onDragEnd={onDragEnd}
									>
										<SortableContext
											items={pendingIds}
											strategy={verticalListSortingStrategy}
										>
											<ul className="tasks-list">
												{pending.map((t) => (
													<SortableTaskRow
														key={t.id}
														t={t}
														bucket={bucketById.get(t.bucket_id)}
														toggling={togglingId === t.id}
														onToggle={(id) => toggleTask.mutate(id)}
														onOpen={(task) => setTaskModal({ task })}
														onSelectTag={selectTag}
														tagColorOf={tagColorOf}
													/>
												))}
												{pending.length === 0 ? (
													<li className="tasks-empty">
														Nothing to do. Piuma approves.
													</li>
												) : null}
											</ul>
										</SortableContext>
									</DndContext>

									{done.length ? (
										<details className="tasks-done">
											<summary>Done · {done.length}</summary>
											<ul className="tasks-list">
												{done.map((t) => (
													<li key={t.id} className="task-row is-done">
														<button
															type="button"
															className="task-check"
															onClick={() => toggleTask.mutate(t.id)}
															disabled={togglingId === t.id}
															aria-label="Reopen task"
														>
															{togglingId === t.id ? (
																<span
																	className="task-spin"
																	aria-hidden="true"
																/>
															) : (
																"☑"
															)}
														</button>
														<button
															type="button"
															className="task-main"
															onClick={() => setTaskModal({ task: t })}
														>
															<span className="task-title">{t.title}</span>
														</button>
													</li>
												))}
											</ul>
										</details>
									) : null}
								</section>
							</>
						) : (
							/* ── Recurring ── */
							<section className="tasks-panel">
								<div className="tasks-panel-head">
									<h2 className="tasks-panel-title">
										Recurring · {recurring.length}
									</h2>
									<PvButton onClick={() => setRecModal({})}>
										+ recurring
									</PvButton>
								</div>
								<ul className="tasks-list">
									{recurring.map((r) => (
										<li
											key={r.id}
											className={`task-row${r.active ? "" : " is-paused"}`}
										>
											<span className="task-check" aria-hidden="true">
												⟳
											</span>
											<button
												type="button"
												className="task-main"
												onClick={() => setRecModal({ recurring: r })}
											>
												<span className="task-title">{r.title}</span>
												<span className="task-meta">
													<span className="task-rrule">{r.rrule}</span>
													<span className="task-due">
														from {formatDate(r.dtstart)}
													</span>
													{!r.active ? (
														<span className="task-tag">paused</span>
													) : null}
												</span>
											</button>
											<button
												type="button"
												className="task-del"
												onClick={() => deleteRecurring.mutate(r.id)}
												aria-label="Delete recurring task"
											>
												✕
											</button>
										</li>
									))}
									{recurring.length === 0 ? (
										<li className="tasks-empty">
											No recurring tasks. Add a workout plan?
										</li>
									) : null}
								</ul>
							</section>
						)}
					</div>
				</div>

				{taskModal ? (
					<TaskModal
						task={taskModal.task}
						defaultTags={taskModal.defaultTags}
						defaultBucket={taskModal.defaultBucket}
						newRank={taskModal.newRank}
						onClose={() => {
							setTaskModal(null);
							clearTaskParam();
						}}
					/>
				) : null}
				{recModal ? (
					<RecurringTaskModal
						recurring={recModal.recurring}
						onClose={() => setRecModal(null)}
					/>
				) : null}
				{manageOpen ? (
					<ManageBucketsModal onClose={() => setManageOpen(false)} />
				) : null}
			</div>
		</WorkspaceShell>
	);
}
