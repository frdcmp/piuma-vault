import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { FallbackSprite } from "../sprites";
import { DOC_GROUPS } from "./docsManifest";
import "../admin/vault-pixel.css";
import "../admin/components/layout/layout.css";
import "./docs.css";

// Public documentation shell. Reuses the admin pixel design language: the left
// rail borrows the vp-sidebar / vp-nav-* classes so it matches the rest of the
// app, and the article (DocsPage) renders inside the same vp-page + PvPanel
// chrome as the Homepage/About pages. No auth — these docs are public. On phones
// the sidebar becomes an off-canvas drawer toggled from the top bar.
export default function DocsLayout() {
	const location = useLocation();
	const [navOpen, setNavOpen] = useState(false);
	const [collapsed, setCollapsed] = useState({});

	// Close the mobile drawer + scroll up whenever the route changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: react to navigation
	useEffect(() => {
		setNavOpen(false);
		window.scrollTo(0, 0);
	}, [location.pathname]);

	useEffect(() => {
		const prev = document.title;
		document.title = "Docs — Piuma Vault";
		return () => {
			document.title = prev;
		};
	}, []);

	const toggle = (group) =>
		setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }));

	return (
		<div className="vp-docs vault-pixel">
			{/* Mobile-only top bar with the drawer toggle. */}
			<header className="vp-docs-topbar">
				<button
					type="button"
					className="vp-icon-btn"
					onClick={() => setNavOpen((v) => !v)}
					aria-label="Toggle navigation"
					aria-expanded={navOpen}
				>
					☰
				</button>
				<Link to="/" className="vp-docs-topbar-brand">
					<span className="vp-docs-topbar-logo" role="img" aria-label="Piuma">
						<FallbackSprite pixelSize={2} />
					</span>
					<span className="vp-sidebar-wordmark">vault</span>
					<span className="vp-docs-badge">docs</span>
				</Link>
			</header>

			<button
				type="button"
				aria-label="Close navigation"
				className={`vp-docs-scrim ${navOpen ? "is-open" : ""}`}
				onClick={() => setNavOpen(false)}
			/>

			<aside
				className={`vp-sidebar vp-docs-sidebar ${navOpen ? "is-open" : ""}`}
			>
				<div className="vp-sidebar-brand">
					<Link to="/" className="vp-sidebar-brand-left vp-docs-brandlink">
						<span className="vp-sidebar-logo" role="img" aria-label="Piuma">
							<FallbackSprite pixelSize={2} />
						</span>
						<span className="vp-sidebar-wordmark">vault</span>
					</Link>
					<span className="vp-docs-badge">docs</span>
				</div>

				<div className="vp-sidebar-nav">
					{DOC_GROUPS.map((group) => {
						const isCollapsed = collapsed[group.group];
						return (
							<div className="vp-nav-section" key={group.group}>
								<button
									type="button"
									className="vp-nav-section-head"
									onClick={() => toggle(group.group)}
								>
									<span>{group.group}</span>
									<span className="vp-nav-caret">
										{isCollapsed ? "▸" : "▾"}
									</span>
								</button>
								{!isCollapsed && (
									<nav className="vp-nav-list">
										{group.items.map((item) => (
											<NavLink
												key={item.slug}
												to={`/docs/${item.slug}`}
												className={({ isActive }) =>
													`vp-nav-item ${isActive ? "vp-nav-item--active" : ""}`
												}
											>
												{item.title}
											</NavLink>
										))}
									</nav>
								)}
							</div>
						);
					})}
				</div>
			</aside>

			<main className="vp-docs-main">
				<Outlet />
			</main>
		</div>
	);
}
