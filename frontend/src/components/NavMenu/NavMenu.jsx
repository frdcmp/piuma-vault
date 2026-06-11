import {
	BookOutlined,
	CalendarOutlined,
	CheckSquareOutlined,
	FileTextOutlined,
	FolderOpenOutlined,
} from "@ant-design/icons";
import { Link, useLocation } from "react-router-dom";
import "./NavMenu.css";

// Cross-app navigation menu — the canonical list of top-level destinations.
// Reused by the admin Header and by the standalone workspace/docs bars so the
// nav vocabulary stays in one place. Active item is matched by route prefix so
// deep routes (e.g. /notes/:id) still light up their parent.
const ITEMS = [
	{ key: "/notes", label: "Notes", icon: <BookOutlined /> },
	{ key: "/tasks", label: "Tasks", icon: <CheckSquareOutlined /> },
	{ key: "/admin/calendar", label: "Calendar", icon: <CalendarOutlined /> },
	{ key: "/storage", label: "Storage", icon: <FolderOpenOutlined /> },
	{ key: "/docs", label: "Docs", icon: <FileTextOutlined /> },
];

export default function NavMenu({ className = "" }) {
	const location = useLocation();

	const isActive = (key) => {
		if (key === "/docs") {
			return (
				location.pathname === "/docs" || location.pathname.startsWith("/docs/")
			);
		}
		return location.pathname === key || location.pathname.startsWith(`${key}/`);
	};

	return (
		<nav className={`nav-menu ${className}`.trim()}>
			{ITEMS.map((item) => (
				<Link
					key={item.key}
					to={item.key}
					className={`nav-menu-link ${isActive(item.key) ? "nav-menu-link--active" : ""}`}
				>
					<span className="nav-menu-link-icon">{item.icon}</span>
					<span className="nav-menu-link-label">{item.label}</span>
				</Link>
			))}
		</nav>
	);
}
