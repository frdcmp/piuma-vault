import "./PvSwitch.css";

/**
 * Pixel on/off toggle (a button with role="switch").
 *
 * Props:
 *   checked:  boolean
 *   onChange: (checked, event) => void
 *   label:    optional node to the right
 *   size:     "md" (default) | "sm"
 *   loading:  disables and dims while a save is in flight
 */
export default function PvSwitch({
	checked = false,
	onChange,
	label,
	size = "md",
	disabled = false,
	loading = false,
	className = "",
	...rest
}) {
	const classes = [
		"pv-switch",
		checked && "is-on",
		size === "sm" && "pv-switch--sm",
		loading && "is-loading",
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			className={classes}
			disabled={disabled || loading}
			onClick={(e) => onChange?.(!checked, e)}
			{...rest}
		>
			<span className="pv-switch-track" aria-hidden="true">
				<span className="pv-switch-thumb" />
			</span>
			{label != null && <span className="pv-switch-label">{label}</span>}
		</button>
	);
}
