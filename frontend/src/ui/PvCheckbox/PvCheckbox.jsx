import { useEffect, useRef } from "react";
import "./PvCheckbox.css";

/**
 * A square pixel-styled checkbox in the vault aesthetic (no Ant Design). The
 * native input is visually hidden but kept for accessibility/keyboard; the
 * `box` span is the painted control. Pass `checked` + `onChange(checked, e)`
 * for controlled use, and an optional `label` rendered to the right.
 * `indeterminate` draws the "some selected" dash (e.g. a select-all header).
 */
export default function PvCheckbox({
	checked = false,
	onChange,
	label,
	disabled = false,
	indeterminate = false,
	className = "",
	...rest
}) {
	const inputRef = useRef(null);
	useEffect(() => {
		if (inputRef.current) inputRef.current.indeterminate = indeterminate;
	}, [indeterminate]);
	return (
		<label
			className={`pv-checkbox${disabled ? " is-disabled" : ""} ${className}`.trim()}
		>
			<input
				ref={inputRef}
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
