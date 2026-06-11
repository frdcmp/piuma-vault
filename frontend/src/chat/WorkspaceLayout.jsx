import { Outlet } from "react-router-dom";
import WorkspaceShell from "./WorkspaceShell";

// Persistent layout route for the workspace pages (Notes, Tasks, Calendar,
// Storage). Because all four render through this single shell, the WorkspaceHeader
// and the ChatDock stay mounted across navigation between them — only the page
// content (the <Outlet/>) swaps. That keeps the chat conversation (and any live
// stream) alive instead of remounting on every page change.
export default function WorkspaceLayout() {
	return (
		<WorkspaceShell>
			<Outlet />
		</WorkspaceShell>
	);
}
