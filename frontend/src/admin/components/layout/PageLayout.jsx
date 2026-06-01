import { Drawer } from "antd";
import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import useUiStore, { SCREEN_MODES } from "../../../store/uiStore";
import "../../vault-pixel.css";
import "./layout.css";
import HeaderComponent from "./Header";
import Sidebar from "./Sidebar";

/**
 * Simple content wrapper for maxWidth centering, in the vault pixel language.
 * Pages render their content inside this (it provides the `.vp-page` scaffold).
 */
export const PageContent = ({ children, maxWidth, variant }) => {
	const cls = [
		"vp-page",
		variant === "wide" && "vp-page--wide",
		variant === "narrow" && "vp-page--narrow",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={cls} style={maxWidth ? { maxWidth } : undefined}>
			{children}
		</div>
	);
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
			<Drawer
				placement="left"
				closable={false}
				onClose={() => setSidebarOpen(false)}
				open={isPhone && sidebarOpen}
				width={240}
				styles={{ body: { padding: 0, background: "#1b1e25" } }}
			>
				<Sidebar inDrawer onNavigate={() => setSidebarOpen(false)} />
			</Drawer>

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

			{/* Mobile menu overlay */}
			{isPhone && sidebarOpen && (
				// biome-ignore lint/a11y/useSemanticElements: backdrop uses div with role button
				<div
					role="button"
					tabIndex={0}
					aria-label="Close sidebar"
					className="vp-shell-overlay"
					onClick={() => setSidebarOpen(false)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") setSidebarOpen(false);
					}}
				/>
			)}
		</div>
	);
};

export default PageLayout;
