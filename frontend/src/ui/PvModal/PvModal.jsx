import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./PvModal.css";

/**
 * Pixel dialog with the three-dot title bar. Escape cancels, Enter confirms.
 *
 * Props:
 *   open, title, children
 *   onConfirm / onCancel: show the OK / Cancel buttons (confirmText, cancelText, danger)
 *   footer:   custom action row replacing OK/Cancel (null = no action row)
 *   width:    CSS width (default: content-sized, 320–480px)
 *   showClose, dismissOnOverlay
 */
export default function PvModal({
	open,
	title = "vault.example.com",
	children,
	onConfirm,
	onCancel,
	confirmText = "OK",
	cancelText = "Cancel",
	danger = false,
	showClose = true,
	dismissOnOverlay = true,
	footer,
	width,
	className = "",
}) {
	const confirmBtnRef = useRef(null);
	const modalRef = useRef(null);

	// Focus ONCE when the modal opens — prefer the first form field (e.g. a
	// rename input), else the confirm button. Keyed on `open` only, so it never
	// re-runs (and steals focus from a field being typed in) when the parent
	// passes a fresh onConfirm/onCancel on each keystroke.
	useEffect(() => {
		if (!open) return;
		const field = modalRef.current?.querySelector("input, textarea, select");
		(field || confirmBtnRef.current)?.focus();
	}, [open]);

	// ESC/Enter handling — re-registered when the handlers change, but this
	// effect never moves focus.
	useEffect(() => {
		if (!open) return;
		const handler = (e) => {
			if (e.key === "Escape") onCancel?.();
			else if (e.key === "Enter") onConfirm?.();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [open, onConfirm, onCancel]);

	if (!open) return null;

	const handleOverlayClick = (e) => {
		if (e.target === e.currentTarget && dismissOnOverlay) onCancel?.();
	};

	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: overlay backdrop, ESC key dismiss is handled globally
		// biome-ignore lint/a11y/useKeyWithClickEvents: overlay backdrop, ESC key dismiss is handled globally
		<div className="pv-modal-overlay" onClick={handleOverlayClick}>
			<div
				ref={modalRef}
				className={`pv-modal ${className}`.trim()}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				style={width != null ? { width, maxWidth: "90vw" } : undefined}
			>
				<div className="pv-modal-titlebar">
					<span className="pv-modal-titlebar-dots">
						<span />
						<span />
						<span />
					</span>
					<h3 className="pv-modal-title">{title}</h3>
					{showClose && onCancel && (
						<button
							type="button"
							className="pv-modal-close"
							onClick={onCancel}
							aria-label="Close"
						>
							×
						</button>
					)}
				</div>

				<div className="pv-modal-body">{children}</div>

				{footer !== undefined ? (
					footer !== null && <div className="pv-modal-actions">{footer}</div>
				) : (
					<div className="pv-modal-actions">
						{onCancel && (
							<button type="button" className="pv-modal-btn" onClick={onCancel}>
								{cancelText}
							</button>
						)}
						{onConfirm && (
							<button
								ref={confirmBtnRef}
								type="button"
								className={`pv-modal-btn ${danger ? "danger" : "primary"}`}
								onClick={onConfirm}
							>
								{confirmText}
							</button>
						)}
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
