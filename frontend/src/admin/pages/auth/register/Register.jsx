import { CheckCircleOutlined } from "@ant-design/icons";
import { Alert, Form, Input } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useRegister } from "../../../../queries";
import { PvButton } from "../../../components/ui";
import "../../../vault-pixel.css";
import "./register.css";

const Register = () => {
	const registerMutation = useRegister();
	const [formError, setFormError] = useState(null);
	const [registeredEmail, setRegisteredEmail] = useState(null);
	const [isAutoVerified, setIsAutoVerified] = useState(false);

	const onFinish = (values) => {
		setFormError(null);
		registerMutation.mutate(
			{ email: values.email, password: values.password },
			{
				onSuccess: (data) => {
					setRegisteredEmail(values.email);
					if (
						data ===
						"Registration successful. You are automatically verified as the first admin user."
					) {
						setIsAutoVerified(true);
					}
				},
				onError: (error) => {
					const msg =
						error?.response?.data || error?.message || "Registration failed";
					setFormError(typeof msg === "string" ? msg : JSON.stringify(msg));
				},
			},
		);
	};

	if (registeredEmail) {
		return (
			<div className="vault-pixel vp-scanlines vp-auth-layout">
				<section className="vp-panel vp-auth-panel">
					<header className="vp-panel-bar">
						<span className="vp-dots">
							<span />
							<span />
							<span />
						</span>
						<h3 className="vp-panel-title">auth — register</h3>
					</header>
					<div className="vp-panel-body vp-auth-center">
						<CheckCircleOutlined className="vp-auth-status-icon vp-auth-status-icon--success" />
						{isAutoVerified ? (
							<>
								<h2 className="vp-h2 vp-auth-title">Registration Successful</h2>
								<p className="vp-text vp-muted">
									You have been automatically verified as the first admin user.
								</p>
								<div className="vp-auth-actions">
									<PvButton variant="primary" to="/admin/login">
										Proceed to Login
									</PvButton>
								</div>
							</>
						) : (
							<>
								<h2 className="vp-h2 vp-auth-title">Check your email</h2>
								<p className="vp-text vp-muted">
									We sent a verification link to{" "}
									<strong className="vp-accent">{registeredEmail}</strong>.
									<br />
									Click the link in the email to activate your account.
								</p>
								<p className="vp-text vp-muted vp-auth-footnote">
									Didn&apos;t receive the email?{" "}
									<Link
										className="vp-link"
										to={`/admin/login?unverified=${encodeURIComponent(registeredEmail)}`}
									>
										Resend verification
									</Link>
								</p>
								<p className="vp-text vp-muted">
									<Link className="vp-link" to="/admin/login">
										Back to login
									</Link>
								</p>
							</>
						)}
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
					<h3 className="vp-panel-title">auth — register</h3>
				</header>
				<div className="vp-panel-body">
					<h2 className="vp-h2 vp-auth-title">Register</h2>
					<p className="vp-text vp-muted vp-auth-subtitle">
						Create a new account.
					</p>

					{formError && (
						<Alert
							message="Registration Failed"
							description={formError}
							type="error"
							showIcon
							style={{ marginBottom: 20 }}
						/>
					)}

					<Form
						name="register"
						onFinish={onFinish}
						layout="vertical"
						size="large"
						className="vp-auth-form"
					>
						<Form.Item
							name="email"
							rules={[
								{ required: true, message: "Please input your email" },
								{ type: "email", message: "Please enter a valid email" },
							]}
						>
							<Input placeholder="Email" />
						</Form.Item>

						<Form.Item
							name="password"
							rules={[
								{ required: true, message: "Please input your password" },
								{ min: 6, message: "Password must be at least 6 characters" },
							]}
						>
							<Input.Password placeholder="Password" />
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
										return Promise.reject(
											new Error("The two passwords do not match"),
										);
									},
								}),
							]}
						>
							<Input.Password placeholder="Confirm Password" />
						</Form.Item>

						<Form.Item>
							<PvButton
								type="submit"
								variant="primary"
								block
								disabled={registerMutation.isPending}
							>
								{registerMutation.isPending ? "Registering..." : "Register"}
							</PvButton>
						</Form.Item>

						<p className="vp-text vp-muted vp-auth-center">
							Already have an account?{" "}
							<Link className="vp-link" to="/admin/login">
								Login now
							</Link>
						</p>
					</Form>
				</div>
			</section>
		</div>
	);
};

export default Register;
