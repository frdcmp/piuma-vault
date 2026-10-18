import { Link } from "react-router-dom";
import "./PvIconButton.css";

/**
 * Square icon-only button (toolbars, panel bars, row actions).
 *
 * Props:
 *   icon:    the glyph (an @ant-design/icons element or a short text glyph)
 *   label:   accessible name + hover title — required, there's no visible text
 *   variant: "default" (bordered tile) | "ghost" (borderless) | "ghost-danger"
 *            (borderless, red on hover — delete ×) | "danger" | "accent"
 *   size:    "md" (30px, default) | "sm" (24px) | "lg" (36px)
 *   active:  pressed/selected look (also sets aria-pressed)
 *   to / href: render a router <Link> / <a> instead of a <button>
 */
const VARIANTS = ["default", "ghost", "ghost-danger", "danger", "accent"];
const SIZES = ["sm", "md", "lg"];

export default function PvIconButton({
	icon,
	label,
	variant = "default",
	size = "md",
	active,
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
		console.warn(
			`PvIconButton: unknown variant "${variant}" or size "${size}"`,
		);
	}
	const classes = [
		"pv-icon-btn",
		variant !== "default" && `pv-icon-btn--${variant}`,
		size !== "md" && `pv-icon-btn--${size}`,
		active && "is-active",
		className,
	]
		.filter(Boolean)
		.join(" ");
	const common = { className: classes, title: label, "aria-label": label };

	if (to) {
		return (
			<Link to={to} {...common} {...rest}>
				{icon}
			</Link>
		);
	}
	if (href) {
		return (
			<a href={href} {...common} {...rest}>
				{icon}
			</a>
		);
	}
	return (
		<button
			type={type}
			aria-pressed={active === undefined ? undefined : active}
			{...common}
			{...rest}
		>
			{icon}
		</button>
	);
}
