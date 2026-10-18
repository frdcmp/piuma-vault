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
 */
export default function PvField({
	label,
	hint,
	error,
	required = false,
	className = "",
	children,
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
		<label className={`vp-field ${className}`.trim()}>
			{label != null && (
				<span className="vp-label">
					{label}
					{required && " *"}
				</span>
			)}
			{children}
			{error ? (
				<span className="vp-field-error">{error}</span>
			) : hint != null ? (
				<span className="vp-field-hint">{hint}</span>
			) : null}
		</label>
	);
}
