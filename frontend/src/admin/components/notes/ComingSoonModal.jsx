import { useEffect } from "react";
import { createPortal } from "react-dom";
import SpriteStage from "./SpriteStage";
import "./ComingSoonModal.css";

// Piuma-flavoured "not built yet" copy, picked by feature so each placeholder
// reads a little differently. Mirrors the mobile ComingSoonModal.
const QUIPS = [
	"is still chewing on this one.",
	"buried this feature in the yard, digging it up soon.",
	"hasn't fetched this one yet. Good boy's working on it.",
	"is on it. Tail wagging, code pending.",
];

// Lightweight Piuma-themed placeholder shown when a not-yet-built feature is
// clicked. The parent owns `open`; pass the feature name for the headline.
export default function ComingSoonModal({ open, feature, quip = 0, onClose }) {
	useEffect(() => {
		if (!open) return;
		const handler = (e) => {
			if (e.key === "Escape" || e.key === "Enter") onClose?.();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [open, onClose]);

	if (!open) return null;

	const handleOverlayClick = (e) => {
		if (e.target === e.currentTarget) onClose?.();
	};

	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: overlay backdrop, ESC key dismiss is handled above
		// biome-ignore lint/a11y/useKeyWithClickEvents: overlay backdrop, ESC key dismiss is handled above
		<div className="coming-soon-overlay" onClick={handleOverlayClick}>
			<div
				className="coming-soon-card"
				role="dialog"
				aria-modal="true"
				aria-label="Coming soon"
			>
				<div className="coming-soon-dog">
					<SpriteStage pixelSize={6} />
				</div>
				<div className="coming-soon-title">Coming soon</div>
				<div className="coming-soon-quip">
					<span className="coming-soon-feature">{feature || "This"}</span>{" "}
					{QUIPS[quip % QUIPS.length]}
				</div>
				<div className="coming-soon-sub">We're working on this feature.</div>
				<button type="button" className="coming-soon-ok" onClick={onClose}>
					OK
				</button>
			</div>
		</div>,
		document.body,
	);
}
