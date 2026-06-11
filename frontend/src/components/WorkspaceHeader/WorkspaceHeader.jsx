import { SettingOutlined } from "@ant-design/icons";
import { Link, useNavigate } from "react-router-dom";
import { Sprite, useSprite } from "../../sprites";
import NavMenu from "../NavMenu/NavMenu";
import UserMenu from "../UserMenu";
import "../../admin/vault-pixel.css";
import "../../admin/components/layout/layout.css";
import "./WorkspaceHeader.css";

// Slim top bar for the standalone workspace pages (Notes, Tasks, Calendar,
// Storage) — deliberately NOT the admin Header. Just the brand, the cross-app
// NavMenu, a settings shortcut, and the user menu.
export default function WorkspaceHeader() {
	const navigate = useNavigate();
	const { sprite } = useSprite();

	return (
		<header className="ws-header">
			<Link to="/notes" className="ws-header-brand" aria-label="Home">
				<span className="ws-header-logo" role="img" aria-label="Piuma">
					<Sprite rows={sprite} pixelSize={2} />
				</span>
				<span className="ws-header-wordmark">vault</span>
			</Link>

			<NavMenu className="ws-header-nav" />

			<div className="ws-header-actions">
				<button
					type="button"
					className="vp-icon-btn"
					title="Settings"
					aria-label="Settings"
					onClick={() => navigate("/admin/security")}
				>
					<SettingOutlined />
				</button>
				<UserMenu size={30} />
			</div>
		</header>
	);
}
