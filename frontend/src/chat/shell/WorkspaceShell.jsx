import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import WorkspaceHeader from "../../components/WorkspaceHeader/WorkspaceHeader";
import useChatDockStore from "../../store/chatDockStore";
import useUiStore from "../../store/uiStore";
import ChatDock from "./ChatDock";
import "./ChatDock.css";

// Shared shell for the workspace pages (Notes, Storage, Tasks, Calendar): the
// slim WorkspaceHeader across the top, the page content (an <Outlet/>, passed as
// children) on the left, and the single ChatDock on the right. Mounted once by
// WorkspaceLayout so the header + chat persist across navigation between pages.
//
// Clicking a note reference inside the chat navigates to that note; on mobile we
// also collapse the chat so the editor becomes visible (only one column shows).
export default function WorkspaceShell({ children }) {
	const navigate = useNavigate();
	const { handleResize, isMobile } = useUiStore();
	const closeChat = useChatDockStore((s) => s.closeChat);

	useEffect(() => {
		handleResize();
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [handleResize]);

	const handleOpenNote = (noteId) => {
		navigate(`/notes/${noteId}`);
		if (isMobile) closeChat();
	};

	return (
		<div className="workspace-shell">
			<WorkspaceHeader />
			<div className="workspace-shell-row">
				{children}
				<ChatDock onOpenNote={handleOpenNote} />
			</div>
		</div>
	);
}
