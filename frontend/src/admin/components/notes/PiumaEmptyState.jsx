import React from "react";
import { useNavigate } from "react-router-dom";
import UserMenu from "../../../components/UserMenu";
import PiumaPixelArt from "./PiumaPixelArt";
import "./PiumaEmptyState.css";

export default function PiumaEmptyState({ onBack, onOpenChat }) {
	const navigate = useNavigate();
	return (
		<div className="piuma-empty-container">
			<div className="piuma-empty-usermenu">
				<UserMenu />
			</div>
			{onBack ? (
				<button
					type="button"
					className="piuma-empty-back"
					onClick={onBack}
					aria-label="Back to notes list"
					title="Back to notes list"
				>
					☰
				</button>
			) : null}
			<PiumaPixelArt pixelSize={8} />
			<div className="piuma-empty-text">Select a note or create a new one</div>
			<div className="piuma-empty-actions">
				<button
					type="button"
					className="piuma-empty-chat-btn"
					onClick={onOpenChat}
				>
					<span className="piuma-empty-chat-icon" aria-hidden="true">
						💬
					</span>
					<span>Chat</span>
				</button>
				<button
					type="button"
					className="piuma-empty-chat-btn"
					onClick={() => navigate("/admin/storage")}
				>
					<span className="piuma-empty-chat-icon" aria-hidden="true">
						▦
					</span>
					<span>Storage</span>
				</button>
			</div>
		</div>
	);
}
