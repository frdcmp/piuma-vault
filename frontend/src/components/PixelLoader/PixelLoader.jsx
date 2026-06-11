import SpriteStage from "../../admin/components/notes/SpriteStage";
import Starfield from "../../admin/components/notes/Starfield";
import "./PixelLoader.css";

/**
 * Full-screen pixel loading screen — the vault's signature transition.
 * The Piuma sprite bobs on the scanline backdrop above a pixel "LOADING" label.
 *
 * Props:
 *   message    — label shown under the sprite (default "Loading").
 *   fadeOut    — when true, fades the whole screen out (use for exit transitions).
 *   starfield  — render the animated pixel starfield behind the content
 *                (matches the screen-lock overlay).
 */
export default function PixelLoader({
	message = "Loading",
	fadeOut = false,
	starfield = false,
}) {
	return (
		<div
			className={`vault-pixel vp-scanlines vp-pixloader${fadeOut ? " is-out" : ""}${starfield ? " vp-pixloader--starfield" : ""}`}
		>
			{starfield && <Starfield />}
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
