import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	useDeleteRecurringTask,
	useDeleteTask,
	useRecurringTasks,
	useTasks,
	useToggleTask,
} from "../../../queries";
import { formatDate, timeAgo } from "../../../utils/dateTime";
import { PvButton } from "../../components/ui";
import RecurringTaskModal from "./RecurringTaskModal";
import TaskModal from "./TaskModal";
import "./Tasks.css";

const PRIORITY = ["", "low", "med", "high"];

export default function TasksPage() {
	const navigate = useNavigate();
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const toggleTask = useToggleTask();
	const deleteTask = useDeleteTask();
	const deleteRecurring = useDeleteRecurringTask();

	const [taskModal, setTaskModal] = useState(null); // { task } | {} | null
	const [recModal, setRecModal] = useState(null);

	// One-off tasks only (materialized recurring occurrences are history, hidden here).
	const oneOff = tasks.filter((t) => !t.recurrence_id);
	const pending = oneOff.filter((t) => !t.done);
	const done = oneOff.filter((t) => t.done);

	return (
		<div className="tasks-page">
			<header className="tasks-header">
				<div className="tasks-title">
					<span className="tasks-glyph" aria-hidden="true">
						☑
					</span>
					<h1>Tasks</h1>
				</div>
				<div className="tasks-actions">
					<PvButton variant="ghost" onClick={() => navigate("/")}>
						‹ home
					</PvButton>
					<PvButton
						variant="ghost"
						onClick={() => navigate("/admin/calendar")}
					>
						calendar ▤
					</PvButton>
					<PvButton variant="accent" onClick={() => setTaskModal({})}>
						+ task
					</PvButton>
				</div>
			</header>

			<div className="tasks-cols">
				{/* ── To-do ── */}
				<section className="tasks-panel">
					<h2 className="tasks-panel-title">To do · {pending.length}</h2>
					<ul className="tasks-list">
						{pending.map((t) => (
							<li key={t.id} className="task-row">
								<button
									type="button"
									className="task-check"
									onClick={() => toggleTask.mutate(t.id)}
									aria-label="Complete task"
								>
									☐
								</button>
								<button
									type="button"
									className="task-main"
									onClick={() => setTaskModal({ task: t })}
								>
									<span className="task-title">{t.title}</span>
									<span className="task-meta">
										{t.priority ? (
											<span className={`task-prio prio-${t.priority}`}>
												{PRIORITY[t.priority]}
											</span>
										) : null}
										{t.due_at ? (
											<span className="task-due">due {timeAgo(t.due_at)}</span>
										) : null}
										{t.tags?.map((tag) => (
											<span key={tag} className="task-tag">
												#{tag}
											</span>
										))}
									</span>
								</button>
								<button
									type="button"
									className="task-del"
									onClick={() => deleteTask.mutate(t.id)}
									aria-label="Delete task"
								>
									✕
								</button>
							</li>
						))}
						{pending.length === 0 ? (
							<li className="tasks-empty">Nothing to do. Piuma approves.</li>
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
											aria-label="Reopen task"
										>
											☑
										</button>
										<span className="task-main">
											<span className="task-title">{t.title}</span>
										</span>
										<button
											type="button"
											className="task-del"
											onClick={() => deleteTask.mutate(t.id)}
											aria-label="Delete task"
										>
											✕
										</button>
									</li>
								))}
							</ul>
						</details>
					) : null}
				</section>

				{/* ── Recurring ── */}
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
			</div>

			{taskModal ? (
				<TaskModal task={taskModal.task} onClose={() => setTaskModal(null)} />
			) : null}
			{recModal ? (
				<RecurringTaskModal
					recurring={recModal.recurring}
					onClose={() => setRecModal(null)}
				/>
			) : null}
		</div>
	);
}
