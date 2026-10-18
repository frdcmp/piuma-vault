import "./PvSegmented.css";

/**
 * A row of mutually exclusive pixel buttons (toggle buttons, one pressed).
 *
 * Props:
 *   options:  Array<{ value, label, disabled? }> | Array<string>
 *   value:    the selected value (an array when `multiple`)
 *   onChange: (value) => void — with `multiple`, the new array of values
 *   multiple: any number of options can be on (e.g. weekday toggles)
 *   size:     "md" (default) | "sm"
 *   block:    stretch to full width, options share it equally
 */
export default function PvSegmented({
	options = [],
	value,
	onChange,
	size = "md",
	block = false,
	multiple = false,
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
	const selected = multiple ? (value ?? []) : [value];
	const toggle = (v) => {
		if (!multiple) {
			if (v !== value) onChange?.(v);
			return;
		}
		onChange?.(
			selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v],
		);
	};
	return (
		<div className={classes} {...rest}>
			{opts.map((o) => {
				const on = selected.includes(o.value);
				return (
					<button
						key={String(o.value)}
						type="button"
						aria-pressed={on}
						disabled={o.disabled}
						className={`pv-segmented-item${on ? " is-active" : ""}`}
						onClick={() => toggle(o.value)}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}
