import "../../../vault-pixel.css";

/**
 * Pixel-style titled panel — a bordered container with the signature
 * three-dot title bar (matching PvModal). The workhorse layout block
 * for vault pages.
 *
 * Props:
 *   title:   text shown in the title bar (omit for a bare panel)
 *   extra:   optional node rendered on the right side of the title bar
 *   noPad:   render the body without default padding (for tables/lists)
 */
export default function PvPanel({
	title,
	extra,
	children,
	noPad = false,
	className = "",
	bodyClassName = "",
	...rest
}) {
	return (
		<section className={`vp-panel ${className}`} {...rest}>
			{title != null && (
				<header className="vp-panel-bar">
					<span className="vp-dots">
						<span />
						<span />
						<span />
					</span>
					<h3 className="vp-panel-title">{title}</h3>
					{extra != null && <div className="vp-panel-bar-extra">{extra}</div>}
				</header>
			)}
			<div
				className={`${noPad ? "" : "vp-panel-body"} ${bodyClassName}`.trim()}
			>
				{children}
			</div>
		</section>
	);
}
