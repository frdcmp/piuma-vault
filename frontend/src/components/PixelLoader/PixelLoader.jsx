import SpriteStage from "../../admin/components/notes/SpriteStage";
import "./PixelLoader.css";

/**
 * Full-screen pixel loading screen — the vault's signature transition.
 * The Piuma sprite bobs on the scanline backdrop above a pixel "LOADING" label.
 *
 * Props:
 *   message  — label shown under the sprite (default "Loading").
 *   fadeOut  — when true, fades the whole screen out (use for exit transitions).
 */
export default function PixelLoader({ message = "Loading", fadeOut = false }) {
	return (
		<div
			className={`vault-pixel vp-scanlines vp-pixloader${fadeOut ? " is-out" : ""}`}
		>
			<div className="vp-pixloader-inner">
				<SpriteStage pixelSize={8} />
				<p className="vp-pixloader-text">
					{message}
					<span className="vp-pixloader-dots" />
				</p>
			</div>
		</div>
	);
}
