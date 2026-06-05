import {
	ApiOutlined,
	AppstoreOutlined,
	BookOutlined,
	DatabaseOutlined,
	DeleteOutlined,
	DownOutlined,
	FolderOpenOutlined,
	HomeOutlined,
	KeyOutlined,
	QuestionCircleOutlined,
	RobotOutlined,
	SearchOutlined,
	SettingOutlined,
	UpOutlined,
} from "@ant-design/icons";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import piumaLogo from "../../../img/dogs/piuma.png";
import SearchModal from "../search/SearchModal";
import SupportModal from "../support/SupportModal";
import "../../vault-pixel.css";
import "./layout.css";

const NAVIGATION = [
	{ key: "/admin", icon: <HomeOutlined />, label: "Home" },
	{ key: "/admin/notes", icon: <BookOutlined />, label: "Vault" },
	{ key: "/admin/agents", icon: <RobotOutlined />, label: "Agents" },
	{ key: "/admin/about", icon: <AppstoreOutlined />, label: "About" },
	{ key: "/storage", icon: <FolderOpenOutlined />, label: "Storage" },
];

const RESOURCES = [
	{ key: "/admin/api-keys", icon: <KeyOutlined />, label: "API Keys" },
	{ key: "/admin/services", icon: <ApiOutlined />, label: "Services" },
	{ key: "/admin/trash", icon: <DeleteOutlined />, label: "Trash" },
	{ key: "/admin/db-backups", icon: <DatabaseOutlined />, label: "Backups" },
	{ key: "/admin/settings", icon: <SettingOutlined />, label: "Settings" },
];

const NavItem = ({ item, active, onNavigate }) => (
	<Link
		to={item.key}
		onClick={onNavigate}
		className={`vp-nav-item ${active ? "vp-nav-item--active" : ""}`}
	>
		<span className="vp-nav-item-icon">{item.icon}</span>
		{item.label}
		{item.count !== undefined && (
			<span className="vp-nav-item-count">{item.count}</span>
		)}
	</Link>
);

const Sidebar = ({ inDrawer = false, onNavigate }) => {
	const location = useLocation();
	const [searchOpen, setSearchOpen] = useState(false);
	const [supportModalOpen, setSupportModalOpen] = useState(false);
	const [expanded, setExpanded] = useState({
		navigation: true,
		resources: true,
	});

	const toggle = (section) =>
		setExpanded((prev) => ({ ...prev, [section]: !prev[section] }));

	// Global keyboard shortcut for search (Cmd+K or Ctrl+K)
	useEffect(() => {
		const handleKeyDown = (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setSearchOpen(true);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	const Section = ({ id, label, items, activeMatch }) => (
		<div className="vp-nav-section">
			<button
				type="button"
				className="vp-nav-section-head"
				onClick={() => toggle(id)}
			>
				<span>{label}</span>
				{expanded[id] ? (
					<UpOutlined className="vp-nav-caret" />
				) : (
					<DownOutlined className="vp-nav-caret" />
				)}
			</button>
			{expanded[id] && (
				<nav className="vp-nav-list">
					{items.map((item) => (
						<NavItem
							key={item.label}
							item={item}
							active={activeMatch ? location.pathname === item.key : false}
							onNavigate={onNavigate}
						/>
					))}
				</nav>
			)}
		</div>
	);

	return (
		<>
			<aside
				className={`vp-sidebar ${inDrawer ? "vp-sidebar--drawer vault-pixel" : ""}`}
			>
				{/* Brand */}
				<div className="vp-sidebar-brand">
					<div className="vp-sidebar-brand-left">
						<img src={piumaLogo} alt="Piuma" className="vp-sidebar-logo" />
						<span className="vp-sidebar-wordmark">vault</span>
					</div>
					<button
						type="button"
						className="vp-icon-btn"
						onClick={() => setSearchOpen(true)}
						title="Search (Ctrl+K)"
						aria-label="Search"
					>
						<SearchOutlined />
					</button>
				</div>

				<SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />

				{/* Navigation */}
				<div className="vp-sidebar-nav">
					<Section
						id="navigation"
						label="Navigation"
						items={NAVIGATION}
						activeMatch
					/>
					<Section id="resources" label="Resources" items={RESOURCES} />
				</div>

				{/* Footer */}
				<div className="vp-sidebar-footer">
					<button
						type="button"
						className="vp-support-btn"
						onClick={() => setSupportModalOpen(true)}
					>
						<QuestionCircleOutlined />
						<span>Support</span>
						<span className="vp-online">
							<span className="vp-online-dot" />
							Online
						</span>
					</button>
				</div>
			</aside>
			<SupportModal
				open={supportModalOpen}
				onCancel={() => setSupportModalOpen(false)}
			/>
		</>
	);
};

export default Sidebar;
