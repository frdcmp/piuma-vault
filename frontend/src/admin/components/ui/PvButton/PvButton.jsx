import { Link } from "react-router-dom";
import "../../../vault-pixel.css";

/**
 * Pixel-style button built on the shared `.vp-btn` language.
 *
 * Renders a <button> by default, an <a> when `href` is set, or a router
 * <Link> when `to` is set — so it can be used for actions and navigation alike.
 *
 * Props:
 *   variant: "default" | "primary" | "danger" | "accent" | "ghost"
 *   size:    "md" (default) | "sm"
 *   block:   stretch to full width
 *   icon:    leading node (e.g. an antd icon)
 *   loading: show a spinner in place of children
 */
export default function PvButton({
	children,
	variant = "default",
	size = "md",
	block = false,
	loading = false,
	icon,
	to,
	href,
	className = "",
	type = "button",
	...rest
}) {
	const classes = [
		"vp-btn",
		variant !== "default" && `vp-btn--${variant}`,
		size === "sm" && "vp-btn--sm",
		block && "vp-btn--block",
		loading && "vp-btn--loading",
		className,
	]
		.filter(Boolean)
		.join(" ");

	const inner = loading ? (
		<span className="vp-btn-spinner" />
	) : (
		<>
			{icon != null && <span className="vp-btn-icon">{icon}</span>}
			{children != null && <span>{children}</span>}
		</>
	);

	if (to) {
		return (
			<Link to={to} className={classes} {...rest}>
				{inner}
			</Link>
		);
	}
	if (href) {
		return (
			<a href={href} className={classes} {...rest}>
				{inner}
			</a>
		);
	}
	return (
		<button type={type} className={classes} {...rest}>
			{inner}
		</button>
	);
}
