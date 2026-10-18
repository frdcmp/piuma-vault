import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Multi-line input on the shared `.vp-textarea` look. Native <textarea> props
 * pass through.
 *
 * Props:
 *   autoSize:  grow with the content instead of scrolling (min height = rows)
 *   maxHeight: cap for autoSize — number (px) or CSS length; past it the
 *              textarea scrolls instead of growing
 *   variant:   "default" (bordered field) | "bare" (no border, background,
 *              padding or min height — for composers that style their own box)
 *   invalid:   red border (validation error)
 */
export default function PvTextarea({
	autoSize = false,
	maxHeight,
	variant = "default",
	invalid = false,
	className = "",
	style,
	value,
	ref,
	...rest
}) {
	const own = useRef(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the value changes
	useLayoutEffect(() => {
		const el = own.current;
		if (autoSize && el) fit(el);
	}, [autoSize, value]);

	// Rewrapping changes the needed height, so re-measure when the width changes
	// (resizable docks / windows). Our own height writes also fire the observer —
	// only react to width.
	useEffect(() => {
		const el = own.current;
		if (!autoSize || !el || typeof ResizeObserver === "undefined") return;
		let lastWidth = el.clientWidth;
		const ro = new ResizeObserver(() => {
			if (el.clientWidth === lastWidth) return;
			lastWidth = el.clientWidth;
			fit(el);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [autoSize]);

	const setRef = (el) => {
		own.current = el;
		if (typeof ref === "function") ref(el);
		else if (ref) ref.current = el;
	};

	const capped = autoSize && maxHeight != null;
	const classes = [
		"vp-textarea",
		variant === "bare" && "vp-textarea--bare",
		autoSize && "vp-textarea--auto",
		capped && "vp-textarea--capped",
		invalid && "vp-invalid",
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<textarea
			ref={setRef}
			className={classes}
			style={capped ? { ...style, maxHeight } : style}
			value={value}
			{...rest}
		/>
	);
}

// Fit the height to the content. scrollHeight excludes the border under
// box-sizing: border-box; add it back so the last line isn't clipped (and, when
// capped, no scrollbar shows before max-height is reached).
function fit(el) {
	el.style.height = "auto";
	const cs = getComputedStyle(el);
	const border =
		parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) || 0;
	el.style.height = `${el.scrollHeight + border}px`;
}
