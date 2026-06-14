import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./PvToast.css";

// Imperative bottom-right toaster with a progress bar. Unlike `pvMessage`
// (transient top-center notices), a toast is a long-lived handle you create,
// update as work progresses, then resolve with success/error. Used for uploads.

const listeners = new Set();
let toasts = [];

function emit() {
	for (const l of listeners) l(toasts);
}

function upsert(toast) {
	const idx = toasts.findIndex((t) => t.id === toast.id);
	toasts =
		idx === -1
			? [...toasts, toast]
			: toasts.map((t) => (t.id === toast.id ? toast : t));
	emit();
}

function remove(id) {
	toasts = toasts.filter((t) => t.id !== id);
	emit();
}

let mounted = false;
function ensureMounted() {
	if (mounted || typeof document === "undefined") return;
	mounted = true;
	const host = document.createElement("div");
	host.id = "pv-toast-root";
	document.body.appendChild(host);
	createRoot(host).render(<PvToastHost />);
}

let seq = 0;

const STATUS_GLYPH = {
	progress: "🐶",
	success: "✓",
	error: "✕",
};

// `progress` is a 0..1 fraction, or null/undefined for an indeterminate bar.
function clampProgress(p) {
	if (p == null || Number.isNaN(p)) return null;
	return Math.max(0, Math.min(1, p));
}

function Toast({ id, label, status, progress }) {
	const pct = clampProgress(progress);
	const indeterminate = status === "progress" && pct == null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: click-to-dismiss only
		// biome-ignore lint/a11y/noStaticElementInteractions: click-to-dismiss only
		<div
			className={`pv-toast pv-toast-${status}`}
			role="status"
			onClick={() => remove(id)}
		>
			<div className="pv-toast-row">
				<span className={`pv-toast-glyph pv-toast-glyph-${status}`}>
					<span
						className={status === "progress" ? "pv-toast-dog" : undefined}
					>
						{STATUS_GLYPH[status] || "•"}
					</span>
				</span>
				<span className="pv-toast-label">{label}</span>
				{pct != null && status === "progress" && (
					<span className="pv-toast-pct">{Math.round(pct * 100)}%</span>
				)}
			</div>
			<div className="pv-toast-track">
				<div
					className={`pv-toast-bar pv-toast-bar-${status} ${
						indeterminate ? "indeterminate" : ""
					}`}
					style={pct != null ? { width: `${pct * 100}%` } : undefined}
				/>
			</div>
		</div>
	);
}

function PvToastHost() {
	const [list, setList] = useState(toasts);

	useEffect(() => {
		const cb = (next) => setList(next);
		listeners.add(cb);
		cb(toasts);
		return () => {
			listeners.delete(cb);
		};
	}, []);

	if (!list.length) return null;

	return (
		<div className="pv-toast-stack" aria-live="polite">
			{list.map((t) => (
				<Toast
					key={t.id}
					id={t.id}
					label={t.label}
					status={t.status}
					progress={t.progress}
				/>
			))}
		</div>
	);
}

// Returns a handle for the lifetime of one task.
function show({ label = "", progress = null } = {}) {
	ensureMounted();
	seq += 1;
	const id = `t_${seq}`;
	upsert({ id, label, status: "progress", progress });

	const update = ({ label: nextLabel, progress: nextProgress } = {}) => {
		const cur = toasts.find((t) => t.id === id);
		if (!cur) return;
		upsert({
			...cur,
			label: nextLabel ?? cur.label,
			progress: nextProgress === undefined ? cur.progress : nextProgress,
		});
	};

	const finish = (status, finalLabel, durationMs = 2200) => {
		const cur = toasts.find((t) => t.id === id);
		upsert({
			id,
			label: finalLabel ?? cur?.label ?? "",
			status,
			progress: status === "success" ? 1 : (cur?.progress ?? null),
		});
		if (durationMs > 0) setTimeout(() => remove(id), durationMs);
	};

	return {
		id,
		update,
		success: (finalLabel, durationMs) =>
			finish("success", finalLabel, durationMs),
		error: (finalLabel, durationMs) => finish("error", finalLabel, durationMs),
		dismiss: () => remove(id),
	};
}

const pvToast = { show, dismiss: remove };

export default pvToast;
