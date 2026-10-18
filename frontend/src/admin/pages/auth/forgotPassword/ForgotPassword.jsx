import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PvAlert, PvButton, PvField, PvInput } from "@/ui";
import { useResetPassword } from "../../../../queries";
import "./forgotPassword.css";

const ForgotPassword = () => {
	const [searchParams] = useSearchParams();
	const resetToken = searchParams.get("token");
	const resetPasswordMutation = useResetPassword();
	const [success, setSuccess] = useState(false);
	const [formError, setFormError] = useState(null);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [fieldErrors, setFieldErrors] = useState({});

	const onSubmit = (e) => {
		e.preventDefault();
		const errors = {};
		if (!password) errors.password = "Please input your new password";
		else if (password.length < 6)
			errors.password = "Password must be at least 6 characters";
		if (!confirm) errors.confirm = "Please confirm your password";
		else if (confirm !== password) errors.confirm = "Passwords do not match";
		setFieldErrors(errors);
		if (Object.keys(errors).length) return;

		setFormError(null);
		resetPasswordMutation.mutate(
			{ token: resetToken, new_password: password },
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
						<PvAlert type="success" title="Success" className="vp-auth-alert">
							Your password has been reset. You can now login.
						</PvAlert>
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
						<PvAlert
							type="error"
							title="Reset Failed"
							className="vp-auth-alert"
						>
							{formError}
						</PvAlert>
					)}

					<form onSubmit={onSubmit} noValidate>
						<PvField error={fieldErrors.password}>
							<PvInput
								type="password"
								reveal
								autoComplete="new-password"
								placeholder="New Password"
								value={password}
								invalid={!!fieldErrors.password}
								onChange={(e) => setPassword(e.target.value)}
							/>
						</PvField>

						<PvField error={fieldErrors.confirm}>
							<PvInput
								type="password"
								reveal
								autoComplete="new-password"
								placeholder="Confirm New Password"
								value={confirm}
								invalid={!!fieldErrors.confirm}
								onChange={(e) => setConfirm(e.target.value)}
							/>
						</PvField>

						<div className="vp-auth-submit">
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
						</div>

						<p className="vp-text vp-muted vp-auth-center">
							<Link className="vp-link" to="/settings/login">
								Back to Login
							</Link>
						</p>
					</form>
				</div>
			</section>
		</div>
	);
};

export default ForgotPassword;
