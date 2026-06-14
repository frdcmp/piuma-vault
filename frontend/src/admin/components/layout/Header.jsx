import {
	MenuOutlined,
	QuestionCircleOutlined,
	SettingOutlined,
} from "@ant-design/icons";
import { Link, useNavigate } from "react-router-dom";
import NavMenu from "../../../components/NavMenu/NavMenu";
import UserMenu from "../../../components/UserMenu";
import { Sprite, useSprite } from "../../../sprites";
import useUiStore, { SCREEN_MODES } from "../../../store/uiStore";
import AppBreadcrumbs from "./Breadcrumbs";
import "../../vault-pixel.css";
import "./layout.css";

const HeaderComponent = ({ onSidebarToggle, showSidebarToggle = false }) => {
	const { screenMode } = useUiStore();
	const { sprite } = useSprite();
	const navigate = useNavigate();
	const isPhone = screenMode === SCREEN_MODES.PHONE;

	return (
		<header className="vp-header">
			<div className="vp-header-inner">
				<div className="vp-header-left">
					{showSidebarToggle && isPhone && (
						<button
							type="button"
							className="vp-icon-btn"
							onClick={onSidebarToggle}
							aria-label="Toggle menu"
						>
							<MenuOutlined />
						</button>
					)}
					{isPhone ? (
						<Link to="/notes" style={{ display: "flex", alignItems: "center" }}>
							<span className="vp-header-logo" role="img" aria-label="Piuma">
								<Sprite rows={sprite} pixelSize={2} />
							</span>
						</Link>
					) : (
						<AppBreadcrumbs />
					)}
				</div>

				{!isPhone && <NavMenu className="vp-header-nav" />}

				<div className="vp-header-right">
					{!isPhone && (
						<>
							<button
								type="button"
								className="vp-icon-btn"
								title="Settings"
								onClick={() => navigate("/settings")}
								aria-label="Settings"
							>
								<SettingOutlined />
							</button>
							<button
								type="button"
								className="vp-icon-btn"
								title="Help"
								aria-label="Help"
							>
								<QuestionCircleOutlined />
							</button>
						</>
					)}
					<UserMenu size={34} />
				</div>
			</div>
		</header>
	);
};

export default HeaderComponent;
