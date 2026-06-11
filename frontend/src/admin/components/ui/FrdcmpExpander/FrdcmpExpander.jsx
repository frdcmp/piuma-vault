import "../../../vault-pixel.css";

/**
 * Pixel-art expander toggle — a small square with a chunky 5-cell "plus" that
 * rotates 45° (into a "×") when expanded. An accent corner pixel lights up in
 * the expanded state for extra feedback.
 *
 * Matches the antd Table `expandIcon` signature: ({ expanded, onExpand, record })
 * — drop it into `expandable.expandIcon` directly.
 */
export default function PvExpander({
	expanded,
	onExpand,
	record,
	...rest
}) {
	return (
		<button
			type="button"
			className={`vp-expander ${expanded ? "vp-expander--open" : ""}`}
			aria-label={expanded ? "Collapse" : "Expand"}
			aria-expanded={!!expanded}
			onClick={(e) => onExpand(record, e)}
			{...rest}
		/>
	);
}
