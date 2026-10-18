import { Link } from "react-router-dom";

/**
 * Pixel-style button built on the shared `.vp-btn` language.
 *
 * Renders a <button> by default, an <a> when `href` is set, or a router
 * <Link> when `to` is set — so it can be used for actions and navigation alike.
 *
 * Props:
 *   variant: "default" | "primary" | "danger" | "accent" | "ghost" | "text"
 *            ("text" = borderless compact label, e.g. in a panel title bar)
 *   size:    "md" (default) | "sm"
 *   block:   stretch to full width
 *   icon:    leading node (e.g. an @ant-design/icons element)
 *   iconEnd: trailing node (e.g. a ▾ caret)
 *   plain:   keep the label's own case (no uppercase) — for user text like titles
 *   loading: show a spinner in place of children
 */
const VARIANTS = ["default", "primary", "danger", "accent", "ghost", "text"];
const SIZES = ["md", "sm"];

export default function PvButton({
	children,
	variant = "default",
	size = "md",
	block = false,
	loading = false,
	icon,
	iconEnd,
	plain = false,
	to,
	href,
	className = "",
	type = "button",
	...rest
}) {
	if (
		import.meta.env.DEV &&
		(!VARIANTS.includes(variant) || !SIZES.includes(size))
	) {
		console.warn(`PvButton: unknown variant "${variant}" or size "${size}"`);
	}
	const classes = [
		"vp-btn",
		variant !== "default" && `vp-btn--${variant}`,
		size === "sm" && "vp-btn--sm",
		block && "vp-btn--block",
		plain && "vp-btn--plain",
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
			{iconEnd != null && <span className="vp-btn-icon">{iconEnd}</span>}
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
