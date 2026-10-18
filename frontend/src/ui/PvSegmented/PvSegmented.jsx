import "./PvSegmented.css";

/**
 * A row of mutually exclusive pixel buttons (toggle buttons, one pressed).
 *
 * Props:
 *   options:  Array<{ value, label, disabled? }> | Array<string>
 *   value:    the selected value
 *   onChange: (value) => void
 *   size:     "md" (default) | "sm"
 *   block:    stretch to full width, options share it equally
 */
export default function PvSegmented({
	options = [],
	value,
	onChange,
	size = "md",
	block = false,
	className = "",
	...rest
}) {
	const opts = options.map((o) =>
		typeof o === "object" ? o : { value: o, label: o },
	);
	const classes = [
		"pv-segmented",
		size === "sm" && "pv-segmented--sm",
		block && "pv-segmented--block",
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={classes} {...rest}>
			{opts.map((o) => (
				<button
					key={String(o.value)}
					type="button"
					aria-pressed={o.value === value}
					disabled={o.disabled}
					className={`pv-segmented-item${o.value === value ? " is-active" : ""}`}
					onClick={() => o.value !== value && onChange?.(o.value)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
