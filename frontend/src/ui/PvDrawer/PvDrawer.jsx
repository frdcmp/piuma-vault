import { useEffect } from "react";
import { createPortal } from "react-dom";
import "./PvDrawer.css";

/**
 * Side panel that slides over the page, with a backdrop. Escape and a click on
 * the backdrop close it.
 *
 * Props:
 *   open, onClose
 *   placement: "left" (default) | "right"
 *   width:     CSS width (default 280)
 *   title:     optional title bar (with the three pixel dots + close)
 */
export default function PvDrawer({
	open,
	onClose,
	placement = "left",
	width = 280,
	title,
	className = "",
	children,
}) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e) => {
			if (e.key === "Escape") onClose?.();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;
	return createPortal(
		<div className="pv-drawer-root">
			<button
				type="button"
				className="pv-drawer-backdrop"
				aria-label="Close"
				onClick={onClose}
			/>
			<aside
				className={`pv-drawer pv-drawer--${placement} ${className}`.trim()}
				style={{ width }}
				role="dialog"
				aria-modal="true"
				aria-label={typeof title === "string" ? title : undefined}
			>
				{title != null && (
					<header className="vp-panel-bar">
						<span className="vp-dots">
							<span />
							<span />
							<span />
						</span>
						<h3 className="vp-panel-title">{title}</h3>
						<button
							type="button"
							className="pv-drawer-close"
							onClick={onClose}
							aria-label="Close"
						>
							×
						</button>
					</header>
				)}
				<div className="pv-drawer-body">{children}</div>
			</aside>
		</div>,
		document.body,
	);
}
