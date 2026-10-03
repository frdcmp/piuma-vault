import { useEffect, useLayoutEffect } from "react";

// Fit a textarea's height to its content (CSS max-height caps it, then it
// scrolls). Re-measures when the text changes AND when the textarea's width
// changes (dock resized, floating window resized), since rewrapping changes
// the needed height.
export default function useAutoGrow(ref, value) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on text change
	useLayoutEffect(() => {
		if (ref.current) fit(ref.current);
	}, [ref, value]);

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		let lastWidth = el.clientWidth;
		const ro = new ResizeObserver(() => {
			// Our own height writes also fire the observer — only react to width.
			if (el.clientWidth === lastWidth) return;
			lastWidth = el.clientWidth;
			fit(el);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
}

function fit(el) {
	el.style.height = "auto";
	// scrollHeight excludes the border under box-sizing: border-box; add it back
	// so the last line isn't clipped and no scrollbar shows before max-height.
	const cs = getComputedStyle(el);
	const bh =
		parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) || 0;
	el.style.height = `${el.scrollHeight + bh}px`;
}
