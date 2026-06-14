import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./PvMessage.css";

const listeners = new Set();
let messages = [];

function emit() {
	for (const l of listeners) l(messages);
}

function add(type, text, durationMs = 2400) {
	const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
	messages = [...messages, { id, type, text }];
	emit();
	if (durationMs > 0) {
		setTimeout(() => remove(id), durationMs);
	}
	return id;
}

function remove(id) {
	messages = messages.filter((m) => m.id !== id);
	emit();
}

let mounted = false;
function ensureMounted() {
	if (mounted || typeof document === "undefined") return;
	mounted = true;
	const host = document.createElement("div");
	host.id = "pv-message-root";
	document.body.appendChild(host);
	createRoot(host).render(<PvMessageHost />);
}

const ICONS = {
	success: "✓",
	error: "✕",
	info: "i",
	warning: "!",
};

function Toast({ id, type, text }) {
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: ephemeral toast, click-to-dismiss only
		// biome-ignore lint/a11y/noStaticElementInteractions: ephemeral toast, click-to-dismiss only
		<div
			className={`pv-message pv-message-${type}`}
			role="status"
			onClick={() => remove(id)}
		>
			<span className={`pv-message-icon pv-message-icon-${type}`}>
				{ICONS[type] || "•"}
			</span>
			<span className="pv-message-text">{text}</span>
		</div>
	);
}

function PvMessageHost() {
	const [list, setList] = useState(messages);

	useEffect(() => {
		const cb = (next) => setList(next);
		listeners.add(cb);
		cb(messages);
		return () => {
			listeners.delete(cb);
		};
	}, []);

	if (!list.length) return null;

	return (
		<div className="pv-message-stack" aria-live="polite">
			{list.map((m) => (
				<Toast key={m.id} id={m.id} type={m.type} text={m.text} />
			))}
		</div>
	);
}

const pvMessage = {
	success(text, durationMs) {
		ensureMounted();
		return add("success", text, durationMs);
	},
	error(text, durationMs) {
		ensureMounted();
		return add("error", text, durationMs);
	},
	info(text, durationMs) {
		ensureMounted();
		return add("info", text, durationMs);
	},
	warning(text, durationMs) {
		ensureMounted();
		return add("warning", text, durationMs);
	},
	dismiss(id) {
		remove(id);
	},
};

export default pvMessage;
