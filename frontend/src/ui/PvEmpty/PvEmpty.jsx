import "./PvEmpty.css";

/**
 * Empty-state block: a pixel glyph, a line of text and an optional action.
 *
 * Props:
 *   description: text (default "Nothing here yet")
 *   icon:        node replacing the default glyph
 *   compact:     less padding, for table cells and small panels
 *   children:    action(s) under the text, e.g. a PvButton
 */
export default function PvEmpty({
	description = "Nothing here yet",
	icon,
	compact = false,
	className = "",
	children,
}) {
	return (
		<div
			className={`pv-empty${compact ? " pv-empty--compact" : ""} ${className}`.trim()}
		>
			<div className="pv-empty-glyph" aria-hidden="true">
				{icon ?? <span className="pv-empty-box" />}
			</div>
			<p className="pv-empty-text">{description}</p>
			{children != null && <div className="pv-empty-actions">{children}</div>}
		</div>
	);
}
