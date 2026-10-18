import { useLayoutEffect, useRef } from "react";

/**
 * Multi-line input on the shared `.vp-textarea` look. Native <textarea> props
 * pass through.
 *
 * Props:
 *   autoSize: grow with the content instead of scrolling (min height = rows)
 *   invalid:  red border (validation error)
 */
export default function PvTextarea({
	autoSize = false,
	invalid = false,
	className = "",
	value,
	ref,
	...rest
}) {
	const own = useRef(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the value changes
	useLayoutEffect(() => {
		const el = own.current;
		if (!autoSize || !el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [autoSize, value]);

	const setRef = (el) => {
		own.current = el;
		if (typeof ref === "function") ref(el);
		else if (ref) ref.current = el;
	};

	const classes = [
		"vp-textarea",
		autoSize && "vp-textarea--auto",
		invalid && "vp-invalid",
		className,
	]
		.filter(Boolean)
		.join(" ");
	return <textarea ref={setRef} className={classes} value={value} {...rest} />;
}
