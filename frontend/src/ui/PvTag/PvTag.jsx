import "./PvTag.css";

/**
 * A pill-shaped tag chip in the pixel aesthetic. The chip border + text take
 * `color` (a tag's registry colour); omit it to fall back to the muted text
 * colour. Pass `onClick` to make the label a button, and/or `onRemove` to render
 * a trailing ✕ as a separate sibling button (kept out of `onClick`).
 */
export default function PvTag({
	color,
	children,
	onClick,
	onRemove,
	removeLabel = "Remove",
	className = "",
	...rest
}) {
	const clickable = typeof onClick === "function";
	return (
		<span
			className={`pv-tag${clickable ? " is-clickable" : ""} ${className}`.trim()}
			style={color ? { borderColor: color, color } : undefined}
			{...rest}
		>
			{clickable ? (
				<button type="button" className="pv-tag-label" onClick={onClick}>
					{children}
				</button>
			) : (
				<span className="pv-tag-label">{children}</span>
			)}
			{onRemove ? (
				<button
					type="button"
					className="pv-tag-x"
					aria-label={removeLabel}
					onClick={(e) => {
						e.stopPropagation();
						onRemove(e);
					}}
				>
					×
				</button>
			) : null}
		</span>
	);
}
