import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import UserMenu from "../../../components/UserMenu";
import { useLogout } from "../../../queries";
import { PvModal } from "../ui";
import ComingSoonModal from "./ComingSoonModal";
import PiumaPixelArt from "./PiumaPixelArt";
import PiumaStarfield from "./PiumaStarfield";
import "./PiumaHome.css";

// Rotating quips — same set as the mobile empty state.
const QUIPS = [
	"Pick a note, or Piuma keeps floating...",
	"Nothing selected. Piuma is judging you.",
	"Empty. Piuma fetched a whole lot of nothing.",
	"No note open — Piuma's getting dizzy up here.",
	"Go on, click something. Piuma dares you.",
	"404: note not selected. Piuma shrugs.",
];

export default function PiumaHome({ onBack, onOpenChat }) {
	const navigate = useNavigate();
	const logout = useLogout();
	const [typed, setTyped] = useState("");
	// Holds the tapped feature ({ label, quip }) while the placeholder modal is
	// open, or null.
	const [comingSoon, setComingSoon] = useState(null);
	const [confirmLogout, setConfirmLogout] = useState(false);

	// Terminal-style typewriter: type a quip out char by char, hold, backspace
	// it, then move to the next one. A single recursive timeout chain drives the
	// whole cycle so the speeds stay independent of React's render cadence.
	useEffect(() => {
		const TYPE_MS = 55; // per character typed
		const DELETE_MS = 25; // per character erased
		const HOLD_MS = 2400; // pause on the full line
		const GAP_MS = 500; // pause on the empty line before the next quip
		let quipIndex = 0;
		let charIndex = 0;
		let deleting = false;
		let timeout;

		const tick = () => {
			const full = QUIPS[quipIndex];
			if (!deleting) {
				charIndex += 1;
				setTyped(full.slice(0, charIndex));
				if (charIndex >= full.length) {
					deleting = true;
					timeout = setTimeout(tick, HOLD_MS);
				} else {
					timeout = setTimeout(tick, TYPE_MS);
				}
			} else {
				charIndex -= 1;
				setTyped(full.slice(0, charIndex));
				if (charIndex <= 0) {
					deleting = false;
					quipIndex = (quipIndex + 1) % QUIPS.length;
					timeout = setTimeout(tick, GAP_MS);
				} else {
					timeout = setTimeout(tick, DELETE_MS);
				}
			}
		};

		timeout = setTimeout(tick, GAP_MS);
		return () => clearTimeout(timeout);
	}, []);

	return (
		<div className="piuma-home-container">
			<PiumaStarfield />
			<div className="piuma-home-usermenu">
				<UserMenu />
			</div>
			{onBack ? (
				<button
					type="button"
					className="piuma-home-back"
					onClick={onBack}
					aria-label="Back to notes list"
					title="Back to notes list"
				>
					☰
				</button>
			) : null}
			<PiumaPixelArt pixelSize={8} />
			<div className="piuma-home-text">
				<span className="piuma-home-typed">
					{typed}
					<span className="piuma-home-cursor" aria-hidden="true" />
				</span>
			</div>

			{/* notes ← | → chat */}
			<div className="piuma-home-hints">
				<button
					type="button"
					className="piuma-hint-pill"
					onClick={() => onBack?.()}
				>
					<span className="piuma-chevrons left" aria-hidden="true">
						<span>‹</span>
						<span>‹</span>
						<span>‹</span>
					</span>
					<span>notes</span>
				</button>
				<span className="piuma-hint-paw" aria-hidden="true">
					🐾
				</span>
				<button type="button" className="piuma-hint-pill" onClick={onOpenChat}>
					<span>chat</span>
					<span className="piuma-chevrons right" aria-hidden="true">
						<span>›</span>
						<span>›</span>
						<span>›</span>
					</span>
				</button>
			</div>

			{/* Vertical menu — Storage is live; Tasks/Calendar are placeholders. */}
			<div className="piuma-home-menu">
				<button
					type="button"
					className="piuma-menu-item"
					onClick={() => navigate("/admin/storage")}
				>
					<span className="piuma-menu-glyph storage" aria-hidden="true">
						▦
					</span>
					<span>storage</span>
				</button>
				<button
					type="button"
					className="piuma-menu-item"
					onClick={() => navigate("/admin/tasks")}
				>
					<span className="piuma-menu-glyph" aria-hidden="true">
						☑
					</span>
					<span>tasks</span>
				</button>
				<button
					type="button"
					className="piuma-menu-item"
					onClick={() => navigate("/admin/calendar")}
				>
					<span className="piuma-menu-glyph" aria-hidden="true">
						▤
					</span>
					<span>calendar</span>
				</button>
				<button
					type="button"
					className="piuma-menu-item is-logout"
					onClick={() => setConfirmLogout(true)}
				>
					<span className="piuma-menu-glyph" aria-hidden="true">
						⏻
					</span>
					<span>logout</span>
				</button>
			</div>

			<ComingSoonModal
				open={!!comingSoon}
				feature={comingSoon?.label}
				quip={comingSoon?.quip || 0}
				onClose={() => setComingSoon(null)}
			/>

			<PvModal
				open={confirmLogout}
				title="Log out?"
				danger
				confirmText="Log out"
				cancelText="Cancel"
				onConfirm={() => {
					setConfirmLogout(false);
					logout();
				}}
				onCancel={() => setConfirmLogout(false)}
			>
				Piuma will miss you. You'll need to sign back in.
			</PvModal>
		</div>
	);
}
