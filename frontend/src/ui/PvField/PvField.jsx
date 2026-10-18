import { useId } from "react";

/**
 * A form row: label + control + hint/error, on the shared `.vp-field` look.
 *
 *   <PvField label="Name" hint="Shown on shares" error={errors.name}>
 *     <PvInput value={name} onChange={…} />
 *   </PvField>
 *
 * Props:
 *   label:    node above the control (rendered as <label> wrapping it)
 *   hint:     muted help text under the control
 *   error:    red text under the control (replaces the hint)
 *   required: adds a "*" to the label
 *   as:       "label" (default — wraps a single native control) | "div" (for
 *             composite controls like PvDateTimePicker or a tag picker; the
 *             label then names the group via aria-labelledby)
 */
export default function PvField({
	label,
	hint,
	error,
	required = false,
	as = "label",
	className = "",
	children,
}) {
	const labelId = useId();
	const caption = label != null && (
		<span className="vp-label" id={labelId}>
			{label}
			{required && " *"}
		</span>
	);
	const foot = error ? (
		<span className="vp-field-error">{error}</span>
	) : hint != null ? (
		<span className="vp-field-hint">{hint}</span>
	) : null;

	if (as === "div") {
		return (
			// biome-ignore lint/a11y/useSemanticElements: a fieldset/legend breaks the flex .vp-field layout
			<div
				className={`vp-field ${className}`.trim()}
				role="group"
				aria-labelledby={label != null ? labelId : undefined}
			>
				{caption}
				{children}
				{foot}
			</div>
		);
	}
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
		<label className={`vp-field ${className}`.trim()}>
			{caption}
			{children}
			{foot}
		</label>
	);
}
