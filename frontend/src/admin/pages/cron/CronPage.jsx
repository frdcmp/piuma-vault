import { useState } from "react";
import {
	useCreateCronJob,
	useCronJobs,
	useCronRuns,
	useDeleteCronJob,
	useRunCronJobNow,
	useToggleCronJob,
	useUpdateCronJob,
} from "../../../queries";
import { formatDateTime, timeAgo } from "../../../utils/dateTime";
import {
	PvButton,
	PvCheckbox,
	PvModal,
	pvMessage,
} from "../../components/ui";
import "./cron.css";

const browserTz = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

const WEEKDAYS = [
	{ key: "MO", label: "Mon" },
	{ key: "TU", label: "Tue" },
	{ key: "WE", label: "Wed" },
	{ key: "TH", label: "Thu" },
	{ key: "FR", label: "Fri" },
	{ key: "SA", label: "Sat" },
	{ key: "SU", label: "Sun" },
];

// Build an ISO instant for "today at HH:MM local" → UTC (the backend reads the
// UTC time-of-day off dtstart). Across DST this can shift by an hour — accepted
// for v1 (matches calendar/tasks recurrence behaviour).
const dtstartFromTime = (hhmm) => {
	const [h, m] = (hhmm || "08:00")
		.split(":")
		.map((n) => Number.parseInt(n, 10));
	const d = new Date();
	d.setHours(h || 0, m || 0, 0, 0);
	return d.toISOString();
};

const timeFromDtstart = (iso) => {
	if (!iso) return "08:00";
	const d = new Date(iso);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Map a stored job back into form state (best-effort RRULE → preset).
const jobToForm = (job) => {
	if (!job) {
		return {
			title: "",
			prompt: "",
			preset: "daily",
			time: "08:00",
			days: ["MO"],
			runAt: "",
			timezone: browserTz(),
			notify: true,
			channels: { web: true, push: true },
			allow_destructive: false,
		};
	}
	let preset = "daily";
	let days = ["MO"];
	if (job.schedule_kind === "once") {
		preset = "once";
	} else if (job.rrule?.includes("WEEKLY")) {
		const m = job.rrule.match(/BYDAY=([A-Z,]+)/);
		const list = m ? m[1].split(",") : [];
		const weekdayKeys = ["MO", "TU", "WE", "TH", "FR"];
		if (list.length === 5 && weekdayKeys.every((k) => list.includes(k))) {
			preset = "weekdays";
		} else {
			preset = "weekly";
			days = list.length ? list : ["MO"];
		}
	} else {
		preset = "daily";
	}
	return {
		title: job.title || "",
		prompt: job.prompt || "",
		preset,
		time: timeFromDtstart(job.dtstart),
		days,
		runAt: job.run_at ? new Date(job.run_at).toISOString().slice(0, 16) : "",
		timezone: job.timezone || browserTz(),
		notify: job.notify ?? true,
		channels: {
			web: (job.notify_channels || []).includes("web"),
			push: (job.notify_channels || []).includes("push"),
		},
		allow_destructive: job.allow_destructive ?? false,
	};
};

// Human-readable schedule summary for the list.
const scheduleLabel = (job) => {
	if (job.schedule_kind === "once") {
		return `Once · ${formatDateTime(job.run_at).date} ${formatDateTime(job.run_at).time}`;
	}
	const t = formatDateTime(job.dtstart).time;
	if (job.rrule?.includes("WEEKLY")) {
		const m = job.rrule.match(/BYDAY=([A-Z,]+)/);
		const list = m ? m[1].split(",") : [];
		const weekdayKeys = ["MO", "TU", "WE", "TH", "FR"];
		if (list.length === 5 && weekdayKeys.every((k) => list.includes(k))) {
			return `Weekdays · ${t}`;
		}
		const names = list
			.map((k) => WEEKDAYS.find((w) => w.key === k)?.label || k)
			.join(", ");
		return `Weekly ${names} · ${t}`;
	}
	return `Daily · ${t}`;
};

const STATUS_CLASS = {
	success: "cron-status--ok",
	error: "cron-status--err",
	timeout: "cron-status--err",
	running: "cron-status--run",
	skipped: "cron-status--muted",
};

function RunHistory({ jobId }) {
	const { data: runs = [], isLoading } = useCronRuns(jobId);
	if (isLoading) return <div className="cron-runs-empty">loading…</div>;
	if (!runs.length) return <div className="cron-runs-empty">No runs yet.</div>;
	return (
		<div className="cron-runs">
			{runs.map((r) => (
				<div key={r.id} className="cron-run">
					<span className={`cron-status ${STATUS_CLASS[r.status] || ""}`}>
						{r.status}
					</span>
					<span
						className="cron-run-time"
						title={formatDateTime(r.started_at).date}
					>
						{timeAgo(r.started_at)}
					</span>
					<span className="cron-run-summary">
						{r.error || r.summary || "—"}
					</span>
					{Array.isArray(r.tools_used) && r.tools_used.length > 0 && (
						<span className="cron-run-tools">{r.tools_used.join(", ")}</span>
					)}
				</div>
			))}
		</div>
	);
}

export default function CronPage() {
	const { data: jobs = [] } = useCronJobs();
	const createJob = useCreateCronJob();
	const updateJob = useUpdateCronJob();
	const deleteJob = useDeleteCronJob();
	const runNow = useRunCronJobNow();
	const toggleJob = useToggleCronJob();

	const [editing, setEditing] = useState(null); // null | job | "new"
	const [form, setForm] = useState(jobToForm(null));
	const [expanded, setExpanded] = useState(null);
	const [pendingDelete, setPendingDelete] = useState(null);
	const [error, setError] = useState("");

	const openNew = () => {
		setForm(jobToForm(null));
		setEditing("new");
		setError("");
	};
	const openEdit = (job) => {
		setForm(jobToForm(job));
		setEditing(job);
		setError("");
	};

	const buildPayload = () => {
		const channels = [
			...(form.channels.web ? ["web"] : []),
			...(form.channels.push ? ["push"] : []),
		];
		const base = {
			title: form.title.trim(),
			prompt: form.prompt.trim(),
			timezone: form.timezone,
			notify: form.notify,
			notify_channels: channels,
			allow_destructive: form.allow_destructive,
		};
		if (form.preset === "once") {
			return {
				...base,
				schedule_kind: "once",
				run_at: form.runAt ? new Date(form.runAt).toISOString() : null,
			};
		}
		let rrule = "FREQ=DAILY";
		if (form.preset === "weekdays") rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
		else if (form.preset === "weekly")
			rrule = `FREQ=WEEKLY;BYDAY=${(form.days.length ? form.days : ["MO"]).join(",")}`;
		return {
			...base,
			schedule_kind: "recurring",
			rrule,
			dtstart: dtstartFromTime(form.time),
		};
	};

	const save = async () => {
		if (!form.title.trim() || !form.prompt.trim()) {
			setError("Title and prompt are required.");
			return;
		}
		if (form.preset === "once" && !form.runAt) {
			setError("Pick a date & time for a one-shot job.");
			return;
		}
		const payload = buildPayload();
		try {
			if (editing === "new") {
				await createJob.mutateAsync(payload);
				pvMessage.success("Scheduled job created");
			} else {
				await updateJob.mutateAsync({ id: editing.id, ...payload });
				pvMessage.success("Job updated");
			}
			setEditing(null);
		} catch (e) {
			setError(e?.response?.data?.error || e?.message || "Failed to save");
		}
	};

	const toggleDay = (key) =>
		setForm((f) => ({
			...f,
			days: f.days.includes(key)
				? f.days.filter((d) => d !== key)
				: [...f.days, key],
		}));

	const isNew = editing === "new";
	const modalTitle = isNew ? "New scheduled job" : "Edit scheduled job";

	return (
		<div className="cron-page">
			<div className="cron-head">
				<div>
					<h2 className="cron-title">Scheduled jobs</h2>
					<p className="cron-sub">
						Run the agent on a schedule — it works headless with its tools and
						posts the result to a per-job conversation + a notification.
					</p>
				</div>
				<PvButton variant="primary" onClick={openNew}>
					+ New job
				</PvButton>
			</div>

			{jobs.length === 0 ? (
				<div className="cron-empty">No scheduled jobs yet.</div>
			) : (
				<div className="cron-list">
					{jobs.map((job) => (
						<div key={job.id} className="cron-job">
							<div className="cron-job-main">
								<button
									type="button"
									className={`cron-job-toggle${job.enabled ? " is-on" : ""}`}
									title={
										job.enabled
											? "Enabled — click to pause"
											: "Paused — click to enable"
									}
									onClick={() => toggleJob.mutate(job.id)}
								>
									{job.enabled ? "●" : "○"}
								</button>
								<div className="cron-job-id">
									<strong className="cron-job-name">{job.title}</strong>
									<span className="cron-job-sched">{scheduleLabel(job)}</span>
								</div>
								<span className="cron-job-next">
									{job.enabled && job.next_run_at
										? `next ${timeAgo(job.next_run_at)}`
										: "paused"}
								</span>
								<div className="cron-job-actions">
									<button
										type="button"
										className="cron-act"
										title="Run now"
										onClick={() => {
											runNow.mutate(job.id);
											pvMessage.success("Queued to run now");
										}}
									>
										▶
									</button>
									<button
										type="button"
										className="cron-act"
										title="Run history"
										onClick={() =>
											setExpanded(expanded === job.id ? null : job.id)
										}
									>
										≡
									</button>
									<button
										type="button"
										className="cron-act"
										title="Edit"
										onClick={() => openEdit(job)}
									>
										✎
									</button>
									<button
										type="button"
										className="cron-act cron-act--danger"
										title="Delete"
										onClick={() => setPendingDelete(job)}
									>
										✕
									</button>
								</div>
							</div>
							{expanded === job.id && <RunHistory jobId={job.id} />}
						</div>
					))}
				</div>
			)}

			<PvModal
				open={!!editing}
				title={modalTitle}
				confirmText={isNew ? "Create" : "Save"}
				onConfirm={save}
				onCancel={() => setEditing(null)}
				className="cron-modal"
			>
				<label className="cron-field">
					<span className="cron-label">Title</span>
					<input
						className="cron-input"
						value={form.title}
						onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
						placeholder="Morning briefing"
					/>
				</label>
				<label className="cron-field">
					<span className="cron-label">Prompt (what the agent should do)</span>
					<textarea
						className="cron-input cron-textarea"
						rows={3}
						value={form.prompt}
						onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
						placeholder="Give me today's tasks and calendar as a note titled 'Today'."
					/>
				</label>

				<div className="cron-field">
					<span className="cron-label">Schedule</span>
					<div className="cron-presets">
						{[
							{ k: "daily", l: "Daily" },
							{ k: "weekdays", l: "Weekdays" },
							{ k: "weekly", l: "Weekly" },
							{ k: "once", l: "Once" },
						].map((p) => (
							<button
								type="button"
								key={p.k}
								className={`cron-preset${form.preset === p.k ? " is-on" : ""}`}
								onClick={() => setForm((f) => ({ ...f, preset: p.k }))}
							>
								{p.l}
							</button>
						))}
					</div>
				</div>

				{form.preset === "weekly" && (
					<div className="cron-field">
						<span className="cron-label">Days</span>
						<div className="cron-days">
							{WEEKDAYS.map((w) => (
								<button
									type="button"
									key={w.key}
									className={`cron-day${form.days.includes(w.key) ? " is-on" : ""}`}
									onClick={() => toggleDay(w.key)}
								>
									{w.label}
								</button>
							))}
						</div>
					</div>
				)}

				{form.preset === "once" ? (
					<label className="cron-field">
						<span className="cron-label">When</span>
						<input
							className="cron-input"
							type="datetime-local"
							value={form.runAt}
							onChange={(e) =>
								setForm((f) => ({ ...f, runAt: e.target.value }))
							}
						/>
					</label>
				) : (
					<label className="cron-field">
						<span className="cron-label">Time of day</span>
						<input
							className="cron-input"
							type="time"
							value={form.time}
							onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
						/>
					</label>
				)}

				<div className="cron-field cron-opts">
					<PvCheckbox
						checked={form.notify}
						onChange={(v) => setForm((f) => ({ ...f, notify: v }))}
						label="Notify on completion"
					/>
					{form.notify && (
						<>
							<PvCheckbox
								checked={form.channels.web}
								onChange={(v) =>
									setForm((f) => ({
										...f,
										channels: { ...f.channels, web: v },
									}))
								}
								label="web"
							/>
							<PvCheckbox
								checked={form.channels.push}
								onChange={(v) =>
									setForm((f) => ({
										...f,
										channels: { ...f.channels, push: v },
									}))
								}
								label="push"
							/>
						</>
					)}
				</div>
				<div className="cron-field">
					<PvCheckbox
						checked={form.allow_destructive}
						onChange={(v) => setForm((f) => ({ ...f, allow_destructive: v }))}
						label="Allow destructive tools (delete notes/tasks/events)"
					/>
					<span className="cron-hint">
						Off by default — unattended runs can't delete your data unless
						enabled.
					</span>
				</div>
				{error && <div className="cron-error">{error}</div>}
			</PvModal>

			<PvModal
				open={!!pendingDelete}
				title="Delete scheduled job"
				danger
				confirmText="Delete"
				onConfirm={() => {
					deleteJob.mutate(pendingDelete.id);
					setPendingDelete(null);
				}}
				onCancel={() => setPendingDelete(null)}
			>
				Delete <strong>{pendingDelete?.title}</strong>? Its run history is
				removed too. This can't be undone.
			</PvModal>
		</div>
	);
}
