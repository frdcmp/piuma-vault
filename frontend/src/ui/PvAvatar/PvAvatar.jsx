import "./PvAvatar.css";

/**
 * Square pixel avatar: an image, or initials/an icon on a tinted tile.
 *
 * Props:
 *   src:   image URL (falls back to children when absent)
 *   alt:   image alt text
 *   size:  px (default 32)
 *   tone:  "accent" | "success" | "danger" | "info" | "violet" | "muted" (default)
 *   children: initials or an icon
 */
export default function PvAvatar({
	src,
	alt = "",
	size = 32,
	tone = "muted",
	className = "",
	children,
	...rest
}) {
	return (
		<span
			className={`pv-avatar pv-avatar--${tone} ${className}`.trim()}
			style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
			{...rest}
		>
			{src ? <img src={src} alt={alt} /> : children}
		</span>
	);
}
