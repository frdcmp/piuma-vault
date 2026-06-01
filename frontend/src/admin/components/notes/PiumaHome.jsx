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
	const [quip, setQuip] = useState(0);
	const [quipShown, setQuipShown] = useState(true);
	// Holds the tapped feature ({ label, quip }) while the placeholder modal is
	// open, or null.
	const [comingSoon, setComingSoon] = useState(null);
	const [confirmLogout, setConfirmLogout] = useState(false);

	// Cycle the quip every few seconds with a quick cross-fade.
	useEffect(() => {
		const id = setInterval(() => {
			setQuipShown(false);
			setTimeout(() => {
				setQuip((q) => (q + 1) % QUIPS.length);
				setQuipShown(true);
			}, 250);
		}, 3800);
		return () => clearInterval(id);
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
			<div className={`piuma-home-text ${quipShown ? "" : "is-hidden"}`}>
				{QUIPS[quip]}
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
					className="piuma-menu-item is-soon"
					onClick={() => setComingSoon({ label: "Tasks & alarms", quip: 0 })}
				>
					<span className="piuma-menu-glyph" aria-hidden="true">
						☑
					</span>
					<span>tasks</span>
				</button>
				<button
					type="button"
					className="piuma-menu-item is-soon"
					onClick={() => setComingSoon({ label: "Calendar", quip: 1 })}
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
