import {
	MenuOutlined,
	QuestionCircleOutlined,
	SettingOutlined,
} from "@ant-design/icons";
import { Link, useNavigate } from "react-router-dom";
import PiumaSprite from "../../../sprites/PiumaSprite";
import { PIUMA_SPRITE } from "../../../sprites/piuma";
import useUiStore, { SCREEN_MODES } from "../../../store/uiStore";
import AppBreadcrumbs from "./Breadcrumbs";
import UserMenu from "./UserMenu";
import "../../vault-pixel.css";
import "./layout.css";

const HeaderComponent = ({ onSidebarToggle, showSidebarToggle = false }) => {
	const { screenMode } = useUiStore();
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
								<PiumaSprite rows={PIUMA_SPRITE} pixelSize={2} />
							</span>
						</Link>
					) : (
						<AppBreadcrumbs />
					)}
				</div>

				<div className="vp-header-right">
					{!isPhone && (
						<>
							<button
								type="button"
								className="vp-icon-btn"
								title="Settings"
								onClick={() => navigate("/admin/settings")}
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
					<UserMenu />
				</div>
			</div>
		</header>
	);
};

export default HeaderComponent;
