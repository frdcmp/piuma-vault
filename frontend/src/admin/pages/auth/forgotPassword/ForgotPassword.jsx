import { Alert, Form, Input } from "antd";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useResetPassword } from "../../../../queries";
import { PvButton } from "../../../components/ui";
import "../../../vault-pixel.css";
import "./forgotPassword.css";

const ForgotPassword = () => {
	const [searchParams] = useSearchParams();
	const resetToken = searchParams.get("token");
	const resetPasswordMutation = useResetPassword();
	const [success, setSuccess] = useState(false);
	const [formError, setFormError] = useState(null);

	const onFinish = (values) => {
		setFormError(null);
		resetPasswordMutation.mutate(
			{ token: resetToken, new_password: values.password },
			{
				onSuccess: () => setSuccess(true),
				onError: (error) => {
					const msg = error?.response?.data || error?.message || "Reset failed";
					setFormError(typeof msg === "string" ? msg : JSON.stringify(msg));
				},
			},
		);
	};

	if (!resetToken) {
		return (
			<div className="vault-pixel vp-scanlines vp-auth-layout">
				<section className="vp-panel vp-auth-panel">
					<header className="vp-panel-bar">
						<span className="vp-dots">
							<span />
							<span />
							<span />
						</span>
						<h3 className="vp-panel-title">auth — forgot password</h3>
					</header>
					<div className="vp-panel-body vp-auth-center">
						<h2 className="vp-h2 vp-auth-title">Forgot Password</h2>
						<p className="vp-text vp-muted">
							Password reset is handled via the backend. Contact an
							administrator or check your server logs for the reset token.
						</p>
						<div className="vp-auth-actions">
							<PvButton to="/settings/login">Back to Login</PvButton>
						</div>
					</div>
				</section>
			</div>
		);
	}

	if (success) {
		return (
			<div className="vault-pixel vp-scanlines vp-auth-layout">
				<section className="vp-panel vp-auth-panel">
					<header className="vp-panel-bar">
						<span className="vp-dots">
							<span />
							<span />
							<span />
						</span>
						<h3 className="vp-panel-title">auth — forgot password</h3>
					</header>
					<div className="vp-panel-body vp-auth-center">
						<h2 className="vp-h2 vp-auth-title">Password Reset</h2>
						<Alert
							message="Success"
							description="Your password has been reset. You can now login."
							type="success"
							showIcon
							style={{ marginBottom: 20, textAlign: "left" }}
						/>
						<div className="vp-auth-actions">
							<PvButton variant="primary" to="/settings/login">
								Go to Login
							</PvButton>
						</div>
					</div>
				</section>
			</div>
		);
	}

	return (
		<div className="vault-pixel vp-scanlines vp-auth-layout">
			<section className="vp-panel vp-auth-panel">
				<header className="vp-panel-bar">
					<span className="vp-dots">
						<span />
						<span />
						<span />
					</span>
					<h3 className="vp-panel-title">auth — forgot password</h3>
				</header>
				<div className="vp-panel-body">
					<h2 className="vp-h2 vp-auth-title">Reset Password</h2>
					<p className="vp-text vp-muted vp-auth-subtitle">
						Enter your new password.
					</p>

					{formError && (
						<Alert
							message="Reset Failed"
							description={formError}
							type="error"
							showIcon
							style={{ marginBottom: 20 }}
						/>
					)}

					<Form
						name="reset-password"
						onFinish={onFinish}
						layout="vertical"
						size="large"
						className="vp-auth-form"
					>
						<Form.Item
							name="password"
							rules={[
								{ required: true, message: "Please input your new password" },
								{ min: 6, message: "Password must be at least 6 characters" },
							]}
						>
							<Input.Password placeholder="New Password" />
						</Form.Item>

						<Form.Item
							name="confirm"
							dependencies={["password"]}
							hasFeedback
							rules={[
								{ required: true, message: "Please confirm your password" },
								({ getFieldValue }) => ({
									validator(_, value) {
										if (!value || getFieldValue("password") === value) {
											return Promise.resolve();
										}
										return Promise.reject(new Error("Passwords do not match"));
									},
								}),
							]}
						>
							<Input.Password placeholder="Confirm New Password" />
						</Form.Item>

						<Form.Item>
							<PvButton
								type="submit"
								variant="primary"
								block
								disabled={resetPasswordMutation.isPending}
							>
								{resetPasswordMutation.isPending
									? "Resetting..."
									: "Reset Password"}
							</PvButton>
						</Form.Item>

						<p className="vp-text vp-muted vp-auth-center">
							<Link className="vp-link" to="/settings/login">
								Back to Login
							</Link>
						</p>
					</Form>
				</div>
			</section>
		</div>
	);
};

export default ForgotPassword;
