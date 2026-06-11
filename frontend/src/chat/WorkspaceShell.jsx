import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import useUiStore from "../store/uiStore";
import ChatDock from "./ChatDock";
import "./ChatDock.css";

// Shared layout layer for the workspace pages (Notes, Storage, Tasks,
// Calendar): page content on the left, the single resizable ChatDock on the
// right. Render the page's own content as children; the dock manages its own
// open/width state via chatDockStore, so it's unified across every page.
//
// `onOpenNote` is forwarded to ChatPanel — invoked when the user clicks a note
// reference inside the chat. Defaults to navigating to that note.

export default function WorkspaceShell({ children, onOpenNote }) {
	const navigate = useNavigate();
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
			<div className="workspace-shell-row">
				{children}
				<ChatDock onOpenNote={handleOpenNote} />
			</div>
		</div>
	);
}
