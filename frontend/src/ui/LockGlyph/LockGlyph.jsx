/**
 * Pixel padlock brand mark for the auth screens.
 *
 * Closed (yellow) once the vault has its account, open (green) during first-run
 * setup while it is still unclaimed. Drawn as a 12×12 pixel grid with
 * `crispEdges` so it stays sharp at any size, matching the vault-pixel language.
 *
 * Props:
 *   open — render the open shackle + "unclaimed" colouring
 *   size — pixel width/height (default 34)
 */
export default function LockGlyph({ open = false, size = 34 }) {
	return (
		<svg
			className={`vp-auth-glyph${open ? " is-open" : ""}`}
			viewBox="0 0 12 12"
			width={size}
			height={size}
			shapeRendering="crispEdges"
			role="img"
			aria-label={open ? "Vault unclaimed" : "Vault locked"}
		>
			{/* Shackle — hinged on the left; the right post lifts clear when open. */}
			<rect x="4" y="1" width="4" height="1" />
			<rect x="3" y="2" width="1" height="4" />
			<rect x="8" y={open ? "1" : "2"} width="1" height={open ? "2" : "4"} />
			{/* Body */}
			<rect x="1" y="6" width="10" height="5" />
			<rect className="vp-auth-glyph-hole" x="5" y="8" width="2" height="2" />
		</svg>
	);
}
