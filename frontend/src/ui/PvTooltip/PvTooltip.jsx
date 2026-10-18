import { useId } from "react";
import "./PvTooltip.css";

/**
 * Hover/focus tooltip, pure CSS (no portal): the bubble is positioned against
 * an inline wrapper around the trigger.
 *
 * Props:
 *   title:     the tooltip content (nothing renders when empty)
 *   placement: "top" (default) | "bottom" | "left" | "right"
 */
export default function PvTooltip({
	title,
	placement = "top",
	className = "",
	children,
}) {
	const id = useId();
	if (title == null || title === "") return children;
	return (
		<span
			className={`pv-tooltip pv-tooltip--${placement} ${className}`.trim()}
			aria-describedby={id}
		>
			{children}
			<span role="tooltip" id={id} className="pv-tooltip-bubble">
				{title}
			</span>
		</span>
	);
}
