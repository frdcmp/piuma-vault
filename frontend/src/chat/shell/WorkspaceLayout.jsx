import { Outlet } from "react-router-dom";
import WorkspaceShell from "./WorkspaceShell";

// When embedded in the mobile app's WebView (the native Recorder screen hosts
// the web `/recorder` scene), render the page bare — no header / chat-dock
// chrome. Detected via the `ReactNativeWebView` bridge the native side injects.
const isEmbedded = typeof window !== "undefined" && !!window.ReactNativeWebView;

// Persistent layout route for the workspace pages (Notes, Tasks, Calendar,
// Storage). Because all four render through this single shell, the WorkspaceHeader
// and the ChatDock stay mounted across navigation between them — only the page
// content (the <Outlet/>) swaps. That keeps the chat conversation (and any live
// stream) alive instead of remounting on every page change.
export default function WorkspaceLayout() {
	// Bare, but in a full-viewport flex column so the page (e.g. the recorder
	// scene with its absolutely-positioned starfield) fills the WebView height.
	// Without this the scene collapses to content height and the starfield stops
	// short — there's no global html/body/#root height chain to inherit from.
	if (isEmbedded)
		return (
			<div
				style={{
					height: "100dvh",
					minHeight: "100vh",
					display: "flex",
					flexDirection: "column",
				}}
			>
				<Outlet />
			</div>
		);
	return (
		<WorkspaceShell>
			<Outlet />
		</WorkspaceShell>
	);
}
