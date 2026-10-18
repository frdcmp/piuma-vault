import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import PvModal from "../PvModal";

/**
 * Imperative confirm dialog — the themed replacement for window.confirm and
 * antd's Modal.confirm. Resolves true on confirm, false on cancel/Escape.
 *
 *   if (!(await pvConfirm({ title: "Delete file?", content: key, danger: true }))) return;
 *
 * Options: title, content (node), okText ("OK"), cancelText ("Cancel"), danger.
 */
let push = null;
const early = []; // requests made before the host mounted

function ConfirmHost() {
	const [queue, setQueue] = useState([]);

	useEffect(() => {
		push = (req) => setQueue((q) => [...q, req]);
		setQueue(early.splice(0));
		return () => {
			push = null;
		};
	}, []);

	const current = queue[0];
	if (!current) return null;
	const close = (answer) => {
		current.resolve(answer);
		setQueue((q) => q.slice(1));
	};
	return (
		<PvModal
			key={current.id}
			open
			title={current.title}
			onConfirm={() => close(true)}
			onCancel={() => close(false)}
			confirmText={current.okText}
			cancelText={current.cancelText}
			danger={current.danger}
		>
			{current.content}
		</PvModal>
	);
}

let mounted = false;
let seq = 0;
function ensureMounted() {
	if (mounted) return;
	mounted = true;
	const host = document.createElement("div");
	host.id = "pv-confirm-root";
	document.body.appendChild(host);
	createRoot(host).render(<ConfirmHost />);
}

export default function pvConfirm({
	title = "Are you sure?",
	content = null,
	okText = "OK",
	cancelText = "Cancel",
	danger = false,
} = {}) {
	ensureMounted();
	return new Promise((resolve) => {
		seq += 1;
		const req = {
			id: seq,
			title,
			content,
			okText,
			cancelText,
			danger,
			resolve,
		};
		if (push) push(req);
		else early.push(req);
	});
}
