import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PixelLoader from "../../../../components/PixelLoader";
import { useAuthStatus, useRegister } from "../../../../queries";
import Starfield from "../../../components/notes/Starfield";
import { LockGlyph, PvButton } from "../../../components/ui";
import "../../../vault-pixel.css";
import "../auth-chrome.css";

/**
 * Mirrors the server-side password policy in
 * `rust/src/apps/auth/handlers.rs::validate_password_policy` so the admin gets
 * live feedback instead of a round-trip rejection.
 */
const passwordChecks = (password, email) => {
	const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
		re.test(password),
	).length;
	return [
		{
			key: "length",
			label: "At least 10 characters",
			ok: password.length >= 10 && password.length <= 256,
		},
		{
			key: "classes",
			label: "3 of: lowercase, uppercase, digit, symbol",
			ok: classes >= 3,
		},
		{
			key: "distinct",
			label: "Not the same as your email",
			ok:
				password.length > 0 &&
				password.toLowerCase() !== email.trim().toLowerCase(),
		},
	];
};

/**
 * One-shot vault setup. Reachable only while the vault has no account —
 * `POST /auth/register` refuses once one exists, and this page mirrors that by
 * showing a closed state instead of a form.
 */
const Register = () => {
	const navigate = useNavigate();
	const authStatus = useAuthStatus();
	const registerMutation = useRegister();

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [formError, setFormError] = useState(null);
	const [landing, setLanding] = useState(false);

	const setupOpen = authStatus.data?.setup_required === true;
	const checkingVault = authStatus.isLoading;

	const checks = useMemo(
		() => passwordChecks(password, email),
		[password, email],
	);
	const confirmOk = confirm.length > 0 && confirm === password;

	const onSubmit = (e) => {
		e.preventDefault();
		if (!email || !password) {
			setFormError("Please enter both email and password.");
			return;
		}
		if (!confirmOk) {
			setFormError("The two passwords do not match.");
			return;
		}
		const unmet = checks.find((c) => !c.ok);
		if (unmet) {
			setFormError(`Password requirement not met: ${unmet.label}.`);
			return;
		}

		setFormError(null);
		registerMutation.mutate(
			{ email, password },
			{
				onSuccess: (data) => {
					// The endpoint hands back tokens, so setup flows straight into
					// the vault rather than bouncing through the login form.
					if (!data?.access_token) {
						navigate("/settings/login");
						return;
					}
					setLanding(true);
					setTimeout(() => navigate("/"), 2000);
				},
				onError: (error) => {
					const msg = error?.response?.data || error?.message || "Setup failed";
					setFormError(typeof msg === "string" ? msg : JSON.stringify(msg));
				},
			},
		);
	};

	if (landing) {
		return <PixelLoader message="Creating vault" />;
	}

	return (
		<div className="vault-pixel vp-scanlines vp-auth-layout vp-auth-immersive">
			<Starfield />

			<div className="vp-auth-stack">
				<div className="vp-auth-brand">
					<LockGlyph open={setupOpen} />
					<div className="vp-auth-brand-text">
						<span className="vp-auth-brand-name">PIUMA VAULT</span>
						<span className="vp-auth-brand-tag">
							{setupOpen
								? "unclaimed — awaiting first admin"
								: "registration closed"}
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
						<h3 className="vp-panel-title">auth — first run</h3>
						<span
							className={`vp-auth-led${setupOpen ? " is-setup" : ""}`}
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

						{/* Already claimed — the endpoint would 403, so don't offer a form. */}
						{!checkingVault && !setupOpen && (
							<>
								<h2 className="vp-h2 vp-auth-title">Registration closed</h2>
								<p className="vp-text vp-muted vp-auth-subtitle">
									This vault already has its administrator account. It holds
									exactly one account, and it can only be created once.
								</p>
								<PvButton variant="primary" block to="/settings/login">
									Go to login
								</PvButton>
							</>
						)}

						{!checkingVault && setupOpen && (
							<>
								<h2 className="vp-h2 vp-auth-title">Claim this vault</h2>
								<p className="vp-text vp-muted vp-auth-subtitle">
									No account exists yet. The credentials below create the
									administrator account and sign you straight in.
								</p>

								{formError && (
									<div className="vp-auth-alert">
										<div className="vp-auth-alert-title">⚠ Setup failed</div>
										{formError}
									</div>
								)}

								<form onSubmit={onSubmit}>
									<div className="vp-field">
										<label className="vp-label" htmlFor="register-email">
											Email
										</label>
										<input
											id="register-email"
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
										<label className="vp-label" htmlFor="register-password">
											Password
										</label>
										<div className="vp-auth-input-wrap">
											<input
												id="register-password"
												className="vp-input vp-auth-input--reveal"
												type={showPassword ? "text" : "password"}
												autoComplete="new-password"
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

									<div className="vp-field">
										<label className="vp-label" htmlFor="register-confirm">
											Confirm password
										</label>
										<input
											id="register-confirm"
											className="vp-input"
											type={showPassword ? "text" : "password"}
											autoComplete="new-password"
											placeholder="••••••••"
											value={confirm}
											onChange={(e) => setConfirm(e.target.value)}
											required
										/>
									</div>

									<ul className="vp-auth-checklist">
										{checks.map((c) => (
											<li key={c.key} className={c.ok ? "is-ok" : undefined}>
												<span
													className="vp-auth-checklist-mark"
													aria-hidden="true"
												>
													{c.ok ? "▪" : "▫"}
												</span>
												{c.label}
											</li>
										))}
										<li className={confirmOk ? "is-ok" : undefined}>
											<span
												className="vp-auth-checklist-mark"
												aria-hidden="true"
											>
												{confirmOk ? "▪" : "▫"}
											</span>
											Both passwords match
										</li>
									</ul>

									<PvButton
										type="submit"
										variant="primary"
										block
										disabled={registerMutation.isPending}
									>
										{registerMutation.isPending
											? "Creating admin..."
											: "Create admin account"}
									</PvButton>

									<p className="vp-text vp-muted vp-auth-note">
										This account is the vault administrator and is verified
										automatically. No further sign-ups are possible afterwards.
									</p>
								</form>

								<p className="vp-text vp-muted vp-auth-center">
									Already set up?{" "}
									<Link className="vp-link" to="/settings/login">
										Login now
									</Link>
								</p>
							</>
						)}
					</div>
				</section>

				<p className="vp-auth-foot">first-run setup · single-admin vault</p>
			</div>
		</div>
	);
};

export default Register;
