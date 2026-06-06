import { useState } from "react";
import { useNavigate } from "react-router-dom";
import WorkspaceShell from "../../../chat/WorkspaceShell";
import BucketTagFilter from "../../../components/BucketTagFilter";
import ManageBucketsModal from "../../../components/ManageBucketsModal";
import TimeAgo from "../../../components/TimeAgo";
import {
	useBuckets,
	useDeleteRecurringTask,
	useRecurringTasks,
	useTagRegistry,
	useTagsLiveUpdates,
	useTasks,
	useTasksLiveUpdates,
	useToggleTask,
} from "../../../queries";
import { formatDate } from "../../../utils/dateTime";
import { tagColor } from "../../../utils/tagColor";
import { PvButton } from "../../components/ui";
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

export default function TasksPage() {
	const navigate = useNavigate();
	useTasksLiveUpdates(); // refetch when tasks change in another tab/device
	useTagsLiveUpdates("tasks"); // keep the tag tree + counts fresh
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const { data: buckets = [] } = useBuckets();
	const { data: tagRegistry = [] } = useTagRegistry();
	const toggleTask = useToggleTask();
	const deleteRecurring = useDeleteRecurringTask();

	const [taskModal, setTaskModal] = useState(null); // { task } | {} | null
	const [recModal, setRecModal] = useState(null);
	const [manageOpen, setManageOpen] = useState(false);
	const [sel, setSel] = useState(ALL); // { key, names, label }
	const [showRecurring, setShowRecurring] = useState(false); // sidebar view toggle

	// Per-tag colour from the registry (falls back to the derived hue).
	const tagColorOf = (name) =>
		tagRegistry.find((r) => r.name === name)?.color || tagColor(name);

	// Bucket lookup for the per-task badge.
	const bucketById = new Map(buckets.map((b) => [b.id, b]));

	// One-off tasks only (materialized recurring occurrences are history, hidden here).
	const oneOff = tasks.filter((t) => !t.recurrence_id);

	// Apply the sidebar selection: a bucket (by the task's own bucket_id), the
	// "no bucket" group, a single tag, or everything.
	let visible = oneOff;
	if (sel.key.startsWith("bucket:"))
		visible = oneOff.filter((t) => t.bucket_id === sel.bucketId);
	else if (sel.key === "nobucket") visible = oneOff.filter((t) => !t.bucket_id);
	else if (sel.names)
		visible = oneOff.filter((t) => t.tags?.some((n) => sel.names.includes(n)));

	// Highest priority first; within a priority tier, cluster tasks that share
	// tags (by normalized tag signature). Untagged tasks (→ "￿") trail.
	const pending = visible
		.filter((t) => !t.done)
		.sort((a, b) => {
			const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
			if (byPriority !== 0) return byPriority;
			const ka = (a.tags ?? []).slice().sort().join(",") || "￿";
			const kb = (b.tags ?? []).slice().sort().join(",") || "￿";
			return ka.localeCompare(kb);
		});
	const done = visible.filter((t) => t.done);

	// The id of the task whose toggle is in flight, so we can spin just its box.
	const togglingId = toggleTask.isPending ? toggleTask.variables : null;

	const selectTag = (tag) => {
		setShowRecurring(false);
		setSel({ key: `tag:${tag}`, names: [tag], label: `#${tag}` });
	};

	const defaultTags = sel.key.startsWith("tag:") ? sel.names : [];
	const defaultBucket = sel.key.startsWith("bucket:") ? sel.bucketId : null;

	// Tag section reflects the selected bucket: only tags used by tasks in that
	// bucket (or "no bucket"). Otherwise ("all"/tag selection) → all tags.
	const tagScope = sel.key.startsWith("bucket:")
		? oneOff.filter((t) => t.bucket_id === sel.bucketId)
		: sel.key === "nobucket"
			? oneOff.filter((t) => !t.bucket_id)
			: oneOff;

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
							onClick={() => setTaskModal({ defaultTags, defaultBucket })}
						>
							+ task
						</PvButton>
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
							selectedKey={showRecurring ? null : sel.key}
							onSelect={(s) => {
								setShowRecurring(false);
								setSel(s);
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
										{sel.key !== "all" ? `${sel.label} · ` : "To do · "}
										{pending.length}
									</h2>
									<ul className="tasks-list">
										{pending.map((t) => (
											<li key={t.id} className="task-row">
												<button
													type="button"
													className="task-check"
													style={{ color: PRIORITY_COLOR[t.priority] }}
													onClick={() => toggleTask.mutate(t.id)}
													disabled={togglingId === t.id}
													aria-label="Complete task"
												>
													{togglingId === t.id ? (
														<span className="task-spin" aria-hidden="true" />
													) : (
														"☐"
													)}
												</button>
												<div className="task-col">
													<button
														type="button"
														className="task-main"
														onClick={() => setTaskModal({ task: t })}
													>
														<span className="task-title">{t.title}</span>
														{t.priority || t.due_at || t.bucket_id ? (
															<span className="task-meta">
																{bucketById.get(t.bucket_id) ? (
																	<span
																		className="task-bucket"
																		style={{
																			color:
																				bucketById.get(t.bucket_id).color ||
																				undefined,
																		}}
																	>
																		{bucketById.get(t.bucket_id).name}
																	</span>
																) : null}
																{t.priority ? (
																	<span
																		className={`task-prio prio-${t.priority}`}
																	>
																		{PRIORITY[t.priority]}
																	</span>
																) : null}
																{t.due_at ? (
																	<span className="task-due">
																		due <TimeAgo value={t.due_at} />
																	</span>
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
																	onClick={() => selectTag(tag)}
																>
																	#{tag}
																</button>
															))}
														</span>
													) : null}
												</div>
											</li>
										))}
										{pending.length === 0 ? (
											<li className="tasks-empty">
												Nothing to do. Piuma approves.
											</li>
										) : null}
									</ul>

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
						onClose={() => setTaskModal(null)}
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
