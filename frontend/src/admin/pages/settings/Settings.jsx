import { PageContent } from "../../components/layout/PageLayout";
import SecuritySettings from "../../components/settings/SecuritySettings";
import "../../vault-pixel.css";
import "./settings.css";

const Settings = () => {
	return (
		<PageContent>
			<div className="vp-page vp-page--narrow vp-settings">
				<div className="vp-page-head">
					<div>
						<h1 className="vp-page-title">Settings</h1>
						<p className="vp-page-subtitle">
							Manage your application preferences and configurations
						</p>
					</div>
				</div>

				<h2 className="vp-h2">🔒 Security</h2>
				<SecuritySettings />
			</div>
		</PageContent>
	);
};

export default Settings;
