import SpriteStage from "../../admin/components/notes/SpriteStage";
import Starfield from "../../admin/components/notes/Starfield";
import "./PixelLoader.css";

/**
 * Full-screen pixel loading screen — the vault's signature transition.
 * Matches the screen-lock overlay: the sprite bobs over the animated pixel
 * starfield above a pixel "LOADING" label.
 *
 * Props:
 *   message  — label shown under the sprite (default "Loading").
 *   fadeOut  — when true, fades the whole screen out (use for exit transitions).
 */
export default function PixelLoader({ message = "Loading", fadeOut = false }) {
	return (
		<div className={`vp-pixloader${fadeOut ? " is-out" : ""}`}>
			<Starfield />
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
