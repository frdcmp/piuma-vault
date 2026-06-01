import {
	CheckCircleOutlined,
	CloseCircleOutlined,
	LoadingOutlined,
} from "@ant-design/icons";
import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useVerifyEmail } from "../../../../queries";
import { PvButton } from "../../../components/ui";
import "../../../vault-pixel.css";
import "./verifyEmail.css";

const VerifyEmail = () => {
	const [searchParams] = useSearchParams();
	const verifyMutation = useVerifyEmail();

	// biome-ignore lint/correctness/useExhaustiveDependencies: verify exactly once on mount
	useEffect(() => {
		const verificationToken = searchParams.get("token");
		if (verificationToken) {
			verifyMutation.mutate({ token: verificationToken });
		}
	}, []);

	const renderContent = () => {
		if (verifyMutation.isPending || verifyMutation.isIdle) {
			return (
				<>
					<LoadingOutlined className="vp-auth-status-icon vp-auth-status-icon--info" />
					<h2 className="vp-h2 vp-auth-title">Verifying your email…</h2>
					<p className="vp-text vp-muted">Please wait a moment.</p>
				</>
			);
		}

		if (verifyMutation.isSuccess) {
			return (
				<>
					<CheckCircleOutlined className="vp-auth-status-icon vp-auth-status-icon--success" />
					<h2 className="vp-h2 vp-auth-title">Email verified!</h2>
					<p className="vp-text vp-muted">
						Your account is now active. You can log in to continue.
					</p>
					<div className="vp-auth-actions">
						<PvButton variant="primary" to="/admin/login">
							Go to Login
						</PvButton>
					</div>
				</>
			);
		}

		const errorMsg =
			verifyMutation.error?.response?.data ||
			verifyMutation.error?.message ||
			"The verification link is invalid or has expired.";

		return (
			<>
				<CloseCircleOutlined className="vp-auth-status-icon vp-auth-status-icon--error" />
				<h2 className="vp-h2 vp-auth-title">Verification failed</h2>
				<p className="vp-text vp-muted">
					{typeof errorMsg === "string" ? errorMsg : "Something went wrong."}
				</p>
				<p className="vp-text vp-muted vp-auth-footnote">
					<Link className="vp-link" to="/admin/login">
						Back to login
					</Link>
				</p>
			</>
		);
	};

	return (
		<div className="vault-pixel vp-scanlines vp-auth-layout">
			<section className="vp-panel vp-auth-panel">
				<header className="vp-panel-bar">
					<span className="vp-dots">
						<span />
						<span />
						<span />
					</span>
					<h3 className="vp-panel-title">auth — verify email</h3>
				</header>
				<div className="vp-panel-body vp-auth-center">{renderContent()}</div>
			</section>
		</div>
	);
};

export default VerifyEmail;
