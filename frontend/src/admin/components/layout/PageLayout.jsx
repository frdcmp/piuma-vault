import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { PvDrawer } from "@/ui";
import useUiStore, { SCREEN_MODES } from "../../../store/uiStore";
import "./layout.css";
import HeaderComponent from "./Header";
import Sidebar from "./Sidebar";

/**
 * Pass-through wrapper kept for backwards compatibility with existing page
 * imports. Width is owned by the layout (`.vp-shell-content-inner`), so this
 * no longer adds any constraints of its own.
 */
export const PageContent = ({ children }) => {
	return <>{children}</>;
};

/**
 * App shell layout — rendered once via React Router layout route.
 * Sidebar, header never remount on navigation.
 */
const PageLayout = () => {
	const { handleResize, screenMode } = useUiStore();
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const isPhone = screenMode === SCREEN_MODES.PHONE;

	useEffect(() => {
		handleResize();
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [handleResize]);

	useEffect(() => {
		if (!isPhone) setSidebarOpen(false);
	}, [isPhone]);

	return (
		<div className="vault-pixel vp-shell">
			{/* Sidebar - hidden on mobile, fixed on desktop */}
			{!isPhone && <Sidebar />}

			{/* Mobile Drawer */}
			<PvDrawer
				placement="left"
				onClose={() => setSidebarOpen(false)}
				open={isPhone && sidebarOpen}
				width={240}
			>
				<Sidebar inDrawer onNavigate={() => setSidebarOpen(false)} />
			</PvDrawer>

			{/* Main content area */}
			<div
				className={`vp-shell-main ${isPhone ? "" : "vp-shell-main--desktop"}`}
			>
				<HeaderComponent
					showSidebarToggle={isPhone}
					onSidebarToggle={() => setSidebarOpen((open) => !open)}
				/>

				<main className="vp-shell-content">
					<div className="vp-shell-content-inner">
						<Outlet />
					</div>
				</main>
			</div>
		</div>
	);
};

export default PageLayout;
