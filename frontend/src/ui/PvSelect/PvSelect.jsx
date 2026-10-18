/**
 * Dropdown on a native <select> with the shared `.vp-select` look — keyboard,
 * mobile pickers and accessibility come for free.
 *
 * Props:
 *   options:     Array<{ value, label, disabled? }> | Array<string>
 *   value:       the selected option's value (any type: numbers stay numbers)
 *   onChange:    (value, event) => void; `undefined` when cleared
 *   placeholder: text of the empty choice, shown while value is null/undefined
 *   allowClear:  keep the empty choice selectable after a value is picked
 *   size:        "md" (default) | "sm"
 *   invalid:     red border
 */
export default function PvSelect({
	options = [],
	value,
	onChange,
	placeholder,
	allowClear = false,
	size = "md",
	invalid = false,
	className = "",
	...rest
}) {
	const opts = options.map((o) =>
		typeof o === "object" ? o : { value: o, label: o },
	);
	const index = opts.findIndex((o) => o.value === value);
	const empty = value == null || index === -1;
	const showEmpty = placeholder != null || allowClear || empty;

	const classes = [
		"vp-select",
		size === "sm" && "vp-input--sm",
		invalid && "vp-invalid",
		empty && "pv-select--placeholder",
		className,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<select
			className={classes}
			value={empty ? "" : String(index)}
			onChange={(e) => {
				const i = e.target.value;
				onChange?.(i === "" ? undefined : opts[Number(i)].value, e);
			}}
			{...rest}
		>
			{showEmpty && (
				<option value="" disabled={!allowClear && !empty}>
					{placeholder ?? ""}
				</option>
			)}
			{opts.map((o, i) => (
				<option key={String(o.value)} value={String(i)} disabled={o.disabled}>
					{o.label}
				</option>
			))}
		</select>
	);
}
