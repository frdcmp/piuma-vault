import "./PvAlert.css";

const GLYPH = { info: "i", success: "✓", warning: "!", error: "✕" };

/**
 * Inline message box (not a toast — use pvMessage/pvToast for those).
 *
 * Props:
 *   type:     "info" (default) | "success" | "warning" | "error"
 *   title:    bold first line
 *   children: body text
 *   onClose:  shows a × that calls it
 */
export default function PvAlert({
	type = "info",
	title,
	onClose,
	className = "",
	children,
}) {
	return (
		<div
			className={`pv-alert pv-alert--${type} ${className}`.trim()}
			role={type === "error" ? "alert" : "status"}
		>
			<span className="pv-alert-glyph" aria-hidden="true">
				{GLYPH[type]}
			</span>
			<div className="pv-alert-body">
				{title != null && <div className="pv-alert-title">{title}</div>}
				{children != null && <div className="pv-alert-text">{children}</div>}
			</div>
			{onClose && (
				<button
					type="button"
					className="pv-alert-close"
					onClick={onClose}
					aria-label="Dismiss"
				>
					×
				</button>
			)}
		</div>
	);
}
