import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import NavMenu from "../components/NavMenu/NavMenu";
import { Sprite, useSprite } from "../sprites";
import useUiStore from "../store/uiStore";
import ChatDock from "./ChatDock";
import "./ChatDock.css";

// Shared layout layer for the workspace pages (Notes, Storage, Tasks,
// Calendar): the shared NavMenu bar across the top, page content on the left,
// the single resizable ChatDock on the right. Render the page's own content
// as children; the dock manages its own open/width state via chatDockStore,
// so it's unified across every page.
//
// `onOpenNote` is forwarded to ChatPanel — invoked when the user clicks a note
// reference inside the chat. Defaults to navigating to that note.

export default function WorkspaceShell({ children, onOpenNote }) {
	const navigate = useNavigate();
	const { sprite } = useSprite();
	const { handleResize } = useUiStore();

	// Keep isMobile in sync — these are standalone full-screen pages with no
	// global layout doing it for them.
	useEffect(() => {
		handleResize();
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [handleResize]);

	const handleOpenNote =
		onOpenNote ?? ((noteId) => navigate(`/notes/${noteId}`));

	return (
		<div className="workspace-shell">
			<header className="app-bar">
				<div className="app-bar-inner">
					<Link to="/notes" className="app-bar-brand" aria-label="Home">
						<span className="app-bar-logo" role="img" aria-label="Piuma">
							<Sprite rows={sprite} pixelSize={2} />
						</span>
						<span className="app-bar-wordmark">vault</span>
					</Link>
					<NavMenu />
				</div>
			</header>
			<div className="workspace-shell-row">
				{children}
				<ChatDock onOpenNote={handleOpenNote} />
			</div>
		</div>
	);
}
