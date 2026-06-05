import { useState } from "react";
import { useNavigate } from "react-router-dom";
import ChatDock from "../../../chat/ChatDock";
import {
	useDeleteRecurringTask,
	useRecurringTasks,
	useTasks,
	useTasksLiveUpdates,
	useToggleTask,
} from "../../../queries";
import { formatDate, timeAgo } from "../../../utils/dateTime";
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

export default function TasksPage() {
	const navigate = useNavigate();
	useTasksLiveUpdates(); // refetch when tasks change in another tab/device
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const toggleTask = useToggleTask();
	const deleteRecurring = useDeleteRecurringTask();

	const [taskModal, setTaskModal] = useState(null); // { task } | {} | null
	const [recModal, setRecModal] = useState(null);
	const [selectedTag, setSelectedTag] = useState(null); // tag string | null (= all)
	const [showRecurring, setShowRecurring] = useState(false); // sidebar view toggle
	const [tagQuery, setTagQuery] = useState(""); // filters the tag list

	// One-off tasks only (materialized recurring occurrences are history, hidden here).
	const oneOff = tasks.filter((t) => !t.recurrence_id);

	// Tags-as-groups: tally every tag in use across one-off tasks.
	const tagCounts = new Map();
	for (const t of oneOff) {
		for (const tag of t.tags ?? []) {
			tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
		}
	}
	const tagList = [...tagCounts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => a.tag.localeCompare(b.tag));
	const tagFilter = tagQuery.trim().toLowerCase();
	const shownTags = tagFilter
		? tagList.filter(({ tag }) => tag.includes(tagFilter))
		: tagList;

	// A removed/emptied tag may still be selected — fall back to "all".
	const activeTag =
		selectedTag && tagCounts.has(selectedTag) ? selectedTag : null;
	const visible = activeTag
		? oneOff.filter((t) => t.tags?.includes(activeTag))
		: oneOff;
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

	return (
		<div className="workspace-row">
			<div className="tasks-page">
				<header className="tasks-header">
					<div className="tasks-title">
						<span className="tasks-glyph" aria-hidden="true">
							☑
						</span>
						<h1>Tasks</h1>
					</div>
					<div className="tasks-actions">
						<PvButton variant="ghost" onClick={() => navigate("/notes")}>
							‹ home
						</PvButton>
						<PvButton
							variant="ghost"
							onClick={() => navigate("/admin/calendar")}
						>
							calendar ▤
						</PvButton>
						<PvButton
							variant="accent"
							onClick={() =>
								setTaskModal({ defaultTags: activeTag ? [activeTag] : [] })
							}
						>
							+ task
						</PvButton>
					</div>
				</header>

				<div className="tasks-body">
					{/* ── Tag groups ── */}
					<aside className="tasks-sidebar">
						<h2 className="tasks-panel-title">Tags</h2>
						<input
							className="tag-search"
							type="text"
							value={tagQuery}
							onChange={(e) => setTagQuery(e.target.value)}
							placeholder="Filter tags…"
							aria-label="Filter tags"
						/>
						<ul className="tag-nav">
							<li>
								<button
									type="button"
									className={`tag-nav-btn${!showRecurring && activeTag === null ? " is-active" : ""}`}
									onClick={() => {
										setShowRecurring(false);
										setSelectedTag(null);
									}}
								>
									<span className="tag-nav-name">all</span>
									<span className="tag-nav-count">{oneOff.length}</span>
								</button>
							</li>
							{shownTags.map(({ tag, count }) => (
								<li key={tag}>
									<button
										type="button"
										className={`tag-nav-btn${!showRecurring && activeTag === tag ? " is-active" : ""}`}
										onClick={() => {
											setShowRecurring(false);
											setSelectedTag(tag);
										}}
									>
										<span
											className="tag-nav-name"
											style={{ color: tagColor(tag) }}
										>
											#{tag}
										</span>
										<span className="tag-nav-count">{count}</span>
									</button>
								</li>
							))}
							{tagList.length === 0 ? (
								<li className="tasks-empty">No tags yet.</li>
							) : shownTags.length === 0 ? (
								<li className="tasks-empty">No matching tags.</li>
							) : null}
						</ul>

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
										{activeTag ? `#${activeTag} · ` : "To do · "}
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
														{t.priority || t.due_at ? (
															<span className="task-meta">
																{t.priority ? (
																	<span
																		className={`task-prio prio-${t.priority}`}
																	>
																		{PRIORITY[t.priority]}
																	</span>
																) : null}
																{t.due_at ? (
																	<span className="task-due">
																		due {timeAgo(t.due_at)}
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
																	style={{ color: tagColor(tag) }}
																	onClick={() => {
																		setShowRecurring(false);
																		setSelectedTag(tag);
																	}}
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
						onClose={() => setTaskModal(null)}
					/>
				) : null}
				{recModal ? (
					<RecurringTaskModal
						recurring={recModal.recurring}
						onClose={() => setRecModal(null)}
					/>
				) : null}
			</div>
			<ChatDock onOpenNote={(noteId) => navigate(`/notes/${noteId}`)} />
		</div>
	);
}
