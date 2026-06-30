import { useEffect, useRef } from "react";
import "./Popover.css";

/**
 * Piuma pixel-art popover (vault-pixel design language). The consumer owns the
 * `open` state and renders the `trigger` (a button that toggles it). Closes on
 * outside click or Escape. `title` renders the three-dot bar; `actions` sits at
 * the bar's right edge. Mirrors the hand-rolled UserMenu dropdown pattern.
 */
export default function PiumaPopover({
	open,
	onOpenChange,
	trigger,
	title,
	actions,
	children,
	width = 320,
	align = "right",
}) {
	const ref = useRef(null);

	useEffect(() => {
		if (!open) return;
		const onClick = (e) => {
			if (ref.current && !ref.current.contains(e.target)) onOpenChange(false);
		};
		const onKey = (e) => e.key === "Escape" && onOpenChange(false);
		document.addEventListener("mousedown", onClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, onOpenChange]);

	return (
		<div className="piuma-pop" ref={ref}>
			{trigger}
			{open && (
				<div
					className={`piuma-pop-panel piuma-pop-panel--${align}`}
					style={{ width }}
				>
					{(title != null || actions) && (
						<div className="piuma-pop-bar">
							<span className="piuma-pop-dots" aria-hidden="true">
								<span />
								<span />
								<span />
							</span>
							{title != null && (
								<span className="piuma-pop-title">{title}</span>
							)}
							{actions && <span className="piuma-pop-actions">{actions}</span>}
						</div>
					)}
					{children}
				</div>
			)}
		</div>
	);
}
