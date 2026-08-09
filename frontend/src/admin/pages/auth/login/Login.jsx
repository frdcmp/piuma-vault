import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import PixelLoader from "../../../../components/PixelLoader";
import {
	useAuthStatus,
	useLogin,
	useLoginOtp,
	useResendVerification,
} from "../../../../queries";
import Starfield from "../../../components/notes/Starfield";
import { LockGlyph, PvButton } from "../../../components/ui";
import "../../../vault-pixel.css";
import "../auth-chrome.css";

const RESEND_COOLDOWN = 30; // seconds

const Login = () => {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const authStatus = useAuthStatus();
	const loginMutation = useLogin();
	const loginOtpMutation = useLoginOtp();
	const resendMutation = useResendVerification();

	const [formError, setFormError] = useState(null);
	const [unverifiedEmail, setUnverifiedEmail] = useState(
		searchParams.get("unverified") || null,
	);
	const [cooldown, setCooldown] = useState(0);
	const [resendSuccess, setResendSuccess] = useState(false);
	const timerRef = useRef(null);

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);

	// First run: the vault holds no account yet, so there is nothing to log into
	// — point at the one-shot setup page instead of showing a form that can only
	// fail. While the status request is in flight we stay in login mode; a failed
	// status call simply leaves the normal form, which still works.
	const setupMode = authStatus.data?.setup_required === true;
	const checkingVault = authStatus.isLoading;

	// Once authenticated, show the pixel loader briefly so entering the vault
	// feels like a transition rather than an instant cut.
	const [landing, setLanding] = useState(false);
	const enterVault = () => {
		setLanding(true);
		setTimeout(() => navigate(redirectTo), 2000);
	};

	// OTP second-step state. otpSession is held in memory only (never
	// localStorage) — it's short-lived and only authorizes the next request.
	const [otpSession, setOtpSession] = useState(null);
	const [otpCode, setOtpCode] = useState("");
	const [trustDevice, setTrustDevice] = useState(false);

	let redirectTo = searchParams.get("redirectTo") || "/";
	const basename = import.meta.env.BASE_URL || "/";
	if (redirectTo.startsWith(basename) && basename !== "/") {
		redirectTo = redirectTo.replace(basename, "/");
	}

	// Auto-trigger resend cooldown if arriving with unverified email in URL
	useEffect(() => {
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, []);

	const startCooldown = () => {
		setCooldown(RESEND_COOLDOWN);
		timerRef.current = setInterval(() => {
			setCooldown((c) => {
				if (c <= 1) {
					clearInterval(timerRef.current);
					return 0;
				}
				return c - 1;
			});
		}, 1000);
	};

	const handleResend = () => {
		if (!unverifiedEmail || cooldown > 0) return;
		setResendSuccess(false);
		resendMutation.mutate(
			{ email: unverifiedEmail },
			{
				onSuccess: () => {
					setResendSuccess(true);
					startCooldown();
				},
			},
		);
	};

	const showRequestError = (error, fallback) => {
		const data = error?.response?.data;
		const msg = data || error?.message || fallback;
		setFormError(typeof msg === "string" ? msg : JSON.stringify(msg));
	};

	const onSubmit = (e) => {
		e.preventDefault();
		if (!email || !password) {
			setFormError("Please enter both email and password.");
			return;
		}

		setFormError(null);
		setUnverifiedEmail(null);
		setResendSuccess(false);
		loginMutation.mutate(
			{ email, password },
			{
				onSuccess: (data) => {
					// H2 collapse: backend now signals "needs email verification"
					// with a 200 + { step: "verify_email_required" } so it can't
					// be used to probe whether an account exists.
					if (data?.step === "verify_email_required") {
						setUnverifiedEmail(data.email || email);
						return;
					}
					if (data?.step === "otp_required") {
						setOtpSession(data.otp_session);
						setOtpCode("");
						return;
					}
					enterVault();
				},
				onError: (error) => showRequestError(error, "Invalid credentials"),
			},
		);
	};

	const onSubmitOtp = (e) => {
		e.preventDefault();
		if (!otpSession) return;
		const trimmed = (otpCode || "").trim();
		if (!trimmed) {
			setFormError("Enter the code from your authenticator app.");
			return;
		}
		setFormError(null);
		loginOtpMutation.mutate(
			{
				otp_session: otpSession,
				code: trimmed,
				trust_device: trustDevice,
				device_label:
					typeof navigator !== "undefined"
						? `${navigator.platform || "Web"} — ${navigator.userAgent?.slice(0, 80) || ""}`
						: undefined,
			},
			{
				onSuccess: (data) => {
					if (!data?.access_token) {
						setFormError("Unexpected response from server.");
						return;
					}
					enterVault();
				},
				onError: (error) => {
					const data = error?.response?.data;
					if (
						data === "Invalid or expired session" ||
						error?.response?.status === 401
					) {
						// Session expired — bounce back to step 1.
						setOtpSession(null);
					}
					showRequestError(error, "Invalid code");
				},
			},
		);
	};

	if (landing) {
		return <PixelLoader message="Entering vault" />;
	}

	let panelTitle = "auth — login";
	if (otpSession) panelTitle = "auth — 2fa";
	else if (setupMode) panelTitle = "auth — first run";

	return (
		<div className="vault-pixel vp-scanlines vp-auth-layout vp-auth-immersive">
			<Starfield />

			<div className="vp-auth-stack">
				<div className="vp-auth-brand">
					<LockGlyph open={setupMode} />
					<div className="vp-auth-brand-text">
						<span className="vp-auth-brand-name">PIUMA VAULT</span>
						<span className="vp-auth-brand-tag">
							{setupMode ? "unclaimed — awaiting first admin" : "secure access"}
						</span>
					</div>
				</div>

				<section className="vp-panel vp-auth-panel">
					<header className="vp-panel-bar">
						<span className="vp-dots">
							<span />
							<span />
							<span />
						</span>
						<h3 className="vp-panel-title">{panelTitle}</h3>
						<span
							className={`vp-auth-led${setupMode ? " is-setup" : ""}`}
							aria-hidden="true"
						/>
					</header>
					<div className="vp-panel-body">
						{checkingVault && (
							<p className="vp-text vp-muted vp-auth-boot">
								Checking vault
								<span className="vp-auth-caret" />
							</p>
						)}

						{/* First run — nothing to log into yet, so send them to setup. */}
						{!checkingVault && setupMode && (
							<>
								<h2 className="vp-h2 vp-auth-title">Vault unclaimed</h2>
								<p className="vp-text vp-muted vp-auth-subtitle">
									No account exists yet. Create the administrator account to get
									started — this happens once, and registration closes for good
									afterwards.
								</p>
								<PvButton variant="primary" block to="/settings/register">
									Set up your vault
								</PvButton>
							</>
						)}

						{!checkingVault && !setupMode && (
							<>
								<h2 className="vp-h2 vp-auth-title">Login</h2>
								<p className="vp-text vp-muted vp-auth-subtitle">
									Welcome back! Please login to your account.
								</p>

								{formError && (
									<div className="vp-auth-alert">
										<div className="vp-auth-alert-title">⚠ Login failed</div>
										{formError}
									</div>
								)}

								{unverifiedEmail && (
									<div className="vp-auth-alert vp-auth-alert--warning">
										<div className="vp-auth-alert-title">
											⚠ Email not verified
										</div>
										<div style={{ marginBottom: 12 }}>
											Please verify your email address before logging in.
										</div>
										{resendSuccess && (
											<div
												style={{
													color: "var(--vp-accent-2)",
													marginBottom: 12,
												}}
											>
												Verification email sent! Check your inbox.
											</div>
										)}
										<PvButton
											type="button"
											block
											size="sm"
											onClick={handleResend}
											disabled={cooldown > 0 || resendMutation.isPending}
										>
											{cooldown > 0
												? `Resend in ${cooldown}s`
												: "Resend verification email"}
										</PvButton>
									</div>
								)}

								{!otpSession && (
									<form onSubmit={onSubmit}>
										<div className="vp-field">
											<label className="vp-label" htmlFor="login-email">
												Email
											</label>
											<input
												id="login-email"
												className="vp-input"
												type="email"
												autoComplete="username"
												placeholder="you@example.com"
												value={email}
												onChange={(e) => setEmail(e.target.value)}
												required
											/>
										</div>

										<div className="vp-field">
											<label className="vp-label" htmlFor="login-password">
												Password
											</label>
											<div className="vp-auth-input-wrap">
												<input
													id="login-password"
													className="vp-input vp-auth-input--reveal"
													type={showPassword ? "text" : "password"}
													autoComplete="current-password"
													placeholder="••••••••"
													value={password}
													onChange={(e) => setPassword(e.target.value)}
													required
												/>
												<button
													type="button"
													className="vp-auth-reveal"
													onClick={() => setShowPassword((v) => !v)}
													aria-label={
														showPassword ? "Hide password" : "Show password"
													}
												>
													{showPassword ? "hide" : "show"}
												</button>
											</div>
										</div>

										<div className="vp-auth-forgot">
											<Link to="/settings/forgot-password" className="vp-link">
												Forgot password?
											</Link>
										</div>

										<PvButton
											type="submit"
											variant="primary"
											block
											disabled={loginMutation.isPending}
										>
											{loginMutation.isPending ? "Logging in..." : "Log in"}
										</PvButton>
									</form>
								)}

								{otpSession && (
									<form onSubmit={onSubmitOtp}>
										<p className="vp-text vp-muted vp-auth-subtitle">
											Enter the 6-digit code from your authenticator app, or a
											backup code if you've lost the device.
										</p>
										<div className="vp-field">
											<label className="vp-label" htmlFor="login-otp">
												Code
											</label>
											<input
												id="login-otp"
												className="vp-input vp-auth-otp-input"
												type="text"
												inputMode="numeric"
												autoComplete="one-time-code"
												placeholder="123456"
												value={otpCode}
												onChange={(e) => setOtpCode(e.target.value)}
												// biome-ignore lint/a11y/noAutofocus: OTP field should focus on step 2
												autoFocus
												required
											/>
										</div>

										<label className="vp-auth-checkbox">
											<input
												type="checkbox"
												checked={trustDevice}
												onChange={(e) => setTrustDevice(e.target.checked)}
											/>
											Trust this device for 30 days
										</label>

										<PvButton
											type="submit"
											variant="primary"
											block
											disabled={loginOtpMutation.isPending}
										>
											{loginOtpMutation.isPending ? "Verifying..." : "Verify"}
										</PvButton>

										<div className="vp-auth-back">
											<button
												type="button"
												className="vp-link vp-auth-back-btn"
												onClick={() => {
													setOtpSession(null);
													setOtpCode("");
													setFormError(null);
												}}
											>
												← Back to login
											</button>
										</div>
									</form>
								)}
							</>
						)}
					</div>
				</section>

				<p className="vp-auth-foot">
					{setupMode
						? "first-run setup · single-admin vault"
						: "encrypted session · piuma vault"}
				</p>
			</div>
		</div>
	);
};

export default Login;
