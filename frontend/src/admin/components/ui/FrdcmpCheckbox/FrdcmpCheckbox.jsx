import "./PvCheckbox.css";

/**
 * A square pixel-styled checkbox in the vault aesthetic (no Ant Design). The
 * native input is visually hidden but kept for accessibility/keyboard; the
 * `box` span is the painted control. Pass `checked` + `onChange(checked, e)`
 * for controlled use, and an optional `label` rendered to the right.
 */
export default function PvCheckbox({
	checked = false,
	onChange,
	label,
	disabled = false,
	className = "",
	...rest
}) {
	return (
		<label
			className={`pv-checkbox${disabled ? " is-disabled" : ""} ${className}`.trim()}
		>
			<input
				type="checkbox"
				className="pv-checkbox-input"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange?.(e.target.checked, e)}
				{...rest}
			/>
			<span className="pv-checkbox-box" aria-hidden="true" />
			{label != null ? (
				<span className="pv-checkbox-label">{label}</span>
			) : null}
		</label>
	);
}
