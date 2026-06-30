import { CloseOutlined } from "@ant-design/icons";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import "./Modal.css";

/**
 * Piuma pixel-art modal (vault-pixel design language): a centered vp-panel with
 * the three-dot title bar, a dedicated backdrop button (closes on click), and
 * Escape-to-close. `footer` renders the action row (use .vp-btn buttons).
 */
export default function PiumaModal({
	open,
	onClose,
	title,
	footer,
	children,
	width = 560,
}) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e) => e.key === "Escape" && onClose();
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;

	return createPortal(
		<div className="piuma-modal-root">
			<button
				type="button"
				className="piuma-modal-overlay"
				aria-label="Close"
				onClick={onClose}
			/>
			<div
				className="piuma-modal"
				role="dialog"
				aria-modal="true"
				style={{ width }}
			>
				<div className="piuma-modal-bar">
					<span className="piuma-modal-dots" aria-hidden="true">
						<span />
						<span />
						<span />
					</span>
					<span className="piuma-modal-title">{title}</span>
					<button
						type="button"
						className="piuma-modal-close"
						aria-label="Close"
						onClick={onClose}
					>
						<CloseOutlined />
					</button>
				</div>
				<div className="piuma-modal-body">{children}</div>
				{footer && <div className="piuma-modal-footer">{footer}</div>}
			</div>
		</div>,
		document.body,
	);
}
