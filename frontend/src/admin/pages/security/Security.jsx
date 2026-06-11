import { PageContent } from "../../components/layout/PageLayout";
import SecuritySettings from "../../components/settings/SecuritySettings";
import "../../vault-pixel.css";

const Security = () => {
	return (
		<PageContent>
			<div className="vp-page">
				<div className="vp-page-head">
					<div>
						<h1 className="vp-page-title">Security</h1>
						<p className="vp-page-subtitle">
							Manage two-factor authentication, sessions, and account security
						</p>
					</div>
				</div>

				<SecuritySettings />
			</div>
		</PageContent>
	);
};

export default Security;
