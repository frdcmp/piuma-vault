import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./PvPopover.css";

/**
 * A floating panel anchored to a trigger element — the lightweight alternative
 * to a full modal for transient controls (filters, pickers, small forms).
 *
 * Controlled: the parent owns `open` and clears it in `onClose`. Pass a ref to
 * the trigger via `anchorRef`; the popover portals to <body>, positions itself
 * just below the anchor (flipping above when there's no room), clamps inside the
 * viewport, and dismisses on Escape or an outside click. Clicks on the anchor
 * itself are ignored here so the trigger can own its own toggle.
 *
 * Props:
 *   align: "start" | "end" — align the popover's left edge to the anchor's left
 *          ("start") or its right edge to the anchor's right ("end").
 *   width: optional fixed width (number → px, or any CSS length string).
 */
export default function PvPopover({
	open,
	anchorRef,
	onClose,
	align = "start",
	gap = 6,
	width,
	className = "",
	children,
}) {
	const popRef = useRef(null);
	// null until measured — kept off-screen + hidden for the first frame so it
	// never flashes at the wrong spot.
	const [pos, setPos] = useState(null);

	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			return;
		}
		const place = () => {
			const anchor = anchorRef?.current;
			const pop = popRef.current;
			if (!anchor || !pop) return;
			const a = anchor.getBoundingClientRect();
			const r = pop.getBoundingClientRect();
			const pad = 8;
			let left = align === "end" ? a.right - r.width : a.left;
			left = Math.min(Math.max(pad, left), window.innerWidth - r.width - pad);
			let top = a.bottom + gap;
			if (top + r.height > window.innerHeight - pad) {
				const above = a.top - gap - r.height;
				top =
					above >= pad
						? above
						: Math.max(pad, window.innerHeight - r.height - pad);
			}
			setPos({ top, left });
		};
		place();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [open, align, gap, anchorRef]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e) => {
			if (e.key === "Escape") onClose?.();
		};
		const onDown = (e) => {
			if (popRef.current?.contains(e.target)) return;
			// Let the anchor handle its own toggle instead of double-firing.
			if (anchorRef?.current?.contains(e.target)) return;
			onClose?.();
		};
		window.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown, true);
		};
	}, [open, onClose, anchorRef]);

	if (!open) return null;

	return createPortal(
		<div
			ref={popRef}
			className={`pv-popover ${className}`.trim()}
			role="dialog"
			style={{
				left: pos?.left ?? -9999,
				top: pos?.top ?? -9999,
				visibility: pos ? "visible" : "hidden",
				...(width != null ? { width } : null),
			}}
		>
			{children}
		</div>,
		document.body,
	);
}
