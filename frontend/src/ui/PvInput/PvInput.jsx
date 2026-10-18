import { useState } from "react";
import "./PvInput.css";

/**
 * Text input on the shared `.vp-input` look. Every native <input> prop passes
 * through (type, value, onChange, placeholder, ref…), so it drops in for a raw
 * <input className="vp-input">.
 *
 * Props:
 *   size:    "md" (default) | "sm"
 *   invalid: red border (validation error)
 *   prefix / suffix: nodes drawn inside the field (icons, units)
 *   reveal:  for type="password", adds a show/hide toggle
 */
export default function PvInput({
	size = "md",
	invalid = false,
	prefix,
	suffix,
	reveal = false,
	type = "text",
	className = "",
	...rest
}) {
	const [shown, setShown] = useState(false);
	const classes = [
		"vp-input",
		size === "sm" && "vp-input--sm",
		invalid && "vp-invalid",
	]
		.filter(Boolean)
		.join(" ");
	const inputType = reveal && type === "password" && shown ? "text" : type;
	const toggle = reveal && type === "password" && (
		<button
			type="button"
			className="pv-input-reveal"
			onClick={() => setShown((s) => !s)}
			aria-label={shown ? "Hide password" : "Show password"}
		>
			{shown ? "HIDE" : "SHOW"}
		</button>
	);

	if (prefix == null && suffix == null && !toggle) {
		return (
			<input
				type={inputType}
				className={`${classes} ${className}`.trim()}
				{...rest}
			/>
		);
	}
	return (
		<span className={`pv-input-wrap ${className}`.trim()}>
			{prefix != null && <span className="pv-input-affix">{prefix}</span>}
			<input type={inputType} className={classes} {...rest} />
			{suffix != null && <span className="pv-input-affix">{suffix}</span>}
			{toggle}
		</span>
	);
}
