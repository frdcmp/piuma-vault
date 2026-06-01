import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLogin } from "../../../queries";

/**
 * Development login page for local testing
 * Authenticates with work.example.com API to get token
 */
const Login = () => {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const [error, setError] = useState(null);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const loginMutation = useLogin();
	const isLoading = loginMutation.isPending;

	// Get where to redirect after login
	let redirectTo = searchParams.get("redirectTo") || "/";

	// Strip the basename from redirectTo if present to prevent double basename redirects
	const basename = import.meta.env.BASE_URL || "/";
	if (redirectTo.startsWith(basename) && basename !== "/") {
		redirectTo = redirectTo.replace(basename, "/");
	}

	const handleOAuthCallback = useCallback(
		(source) => {
			try {
				// Try to extract token from hash or query
				const params = new URLSearchParams(
					source.startsWith("#") ? source.substring(1) : source.substring(1),
				);
				const token = params.get("access_token") || params.get("token");

				if (token) {
					localStorage.setItem("token", token);
					// Clear the URL to remove token
					window.history.replaceState(
						{},
						document.title,
						window.location.pathname,
					);
					navigate(redirectTo);
				}
			} catch (err) {
				console.error("Error handling OAuth callback:", err);
				setError("Failed to process login response");
			}
		},
		[navigate, redirectTo],
	);

	useEffect(() => {
		// Always clear any existing token when devlogin loads
		localStorage.removeItem("token");
		localStorage.removeItem("refreshToken");

		// Check if we're returning from OAuth (look for token in URL hash or query)
		const hash = window.location.hash;
		const queryString = window.location.search;

		if (hash.includes("access_token")) {
			handleOAuthCallback(hash);
		} else if (queryString.includes("token")) {
			handleOAuthCallback(queryString);
		}
	}, [handleOAuthCallback]);

	const handleLoginClick = async () => {
		setError(null);
		try {
			const data = await loginMutation.mutateAsync({ email, password });
			const accessToken = data.access;
			const refreshToken = data.refresh;

			if (!accessToken) {
				throw new Error("No token received from server");
			}

			localStorage.setItem("token", accessToken);
			if (refreshToken) {
				localStorage.setItem("refreshToken", refreshToken);
			}

			navigate(redirectTo);
		} catch (err) {
			console.error("Login error:", err);
			setError(err.message || "Failed to login. Please try again.");
		}
	};

	const handleTokenPaste = () => {
		// Show a dialog for manual token input (for dev/testing)
		const token = prompt(
			"Paste your JWT token here (for development testing only):",
		);
		if (token?.trim()) {
			try {
				// Basic validation - JWT should have 3 parts
				if (token.split(".").length === 3) {
					localStorage.setItem("token", token.trim());
					navigate(redirectTo);
				} else {
					setError("Invalid token format. JWT should have 3 parts.");
				}
			} catch {
				setError("Error storing token");
			}
		}
	};

	const containerStyle = {
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		minHeight: "100vh",
		background: "linear-gradient(135deg, #1890ff 0%, #001529 100%)", // AntD default blue to dark
		fontFamily:
			'-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
		padding: "20px",
	};

	const cardStyle = {
		background: "white",
		borderRadius: "12px",
		boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
		maxWidth: "400px",
		width: "100%",
		overflow: "hidden",
	};

	const headerStyle = {
		background: "linear-gradient(135deg, #1890ff 0%, #0050b3 100%)",
		color: "white",
		padding: "40px 30px 30px",
		textAlign: "center",
	};

	const titleStyle = {
		margin: 0,
		fontSize: "32px",
		fontWeight: 700,
		letterSpacing: "-0.5px",
	};

	const badgeStyle = {
		margin: "12px 0 0",
		fontSize: "12px",
		fontWeight: 600,
		textTransform: "uppercase",
		letterSpacing: "1px",
		opacity: 0.9,
		background: "rgba(255, 255, 255, 0.2)",
		display: "inline-block",
		padding: "4px 12px",
		borderRadius: "20px",
	};

	const contentStyle = {
		padding: "40px 30px",
	};

	const contentHeadingStyle = {
		margin: "0 0 30px",
		fontSize: "24px",
		fontWeight: 600,
		color: "#1a1a1a",
		textAlign: "center",
	};

	const errorStyle = {
		background: "#fee",
		border: "1px solid #fcc",
		color: "#c00",
		padding: "12px 16px",
		borderRadius: "6px",
		marginBottom: "20px",
		fontSize: "14px",
		textAlign: "center",
	};

	const buttonStyle = {
		width: "100%",
		padding: "12px 16px",
		border: "none",
		borderRadius: "8px",
		fontSize: "16px",
		fontWeight: 600,
		cursor: "pointer",
		transition: "all 0.3s ease",
		marginBottom: "16px",
	};

	const primaryButtonStyle = {
		...buttonStyle,
		background: "#1890ff",
		color: "white",
		boxShadow: "0 4px 15px rgba(24, 144, 255, 0.4)",
	};

	const secondaryButtonStyle = {
		...buttonStyle,
		background: "#f0f0f0",
		color: "#333",
		border: "2px solid #e0e0e0",
	};

	const dividerStyle = {
		textAlign: "center",
		margin: "24px 0",
		color: "#999",
		fontSize: "14px",
		fontWeight: 500,
		position: "relative",
	};

	const hintStyle = {
		margin: "24px 0 0",
		fontSize: "13px",
		color: "#666",
		lineHeight: 1.5,
		textAlign: "center",
		fontStyle: "italic",
	};

	const inputStyle = {
		width: "100%",
		padding: "12px 16px",
		marginBottom: "12px",
		border: "1px solid #e0e0e0",
		borderRadius: "6px",
		fontSize: "14px",
		fontFamily: "inherit",
		boxSizing: "border-box",
		transition: "border-color 0.3s ease",
	};

	return (
		<div style={containerStyle}>
			<div style={cardStyle}>
				<div style={headerStyle}>
					<h1 style={titleStyle}>pv App</h1>
					<p style={badgeStyle}>Development Mode</p>
				</div>

				<div style={contentStyle}>
					<h2 style={contentHeadingStyle}>Login to Continue</h2>

					{error && <div style={errorStyle}>{error}</div>}

					<input
						type="email"
						placeholder="Email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						style={inputStyle}
						disabled={isLoading}
					/>

					<input
						type="password"
						placeholder="Password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						style={inputStyle}
						disabled={isLoading}
						onKeyPress={(e) => {
							if (e.key === "Enter" && !isLoading) {
								handleLoginClick();
							}
						}}
					/>

					<button
						type="button"
						style={primaryButtonStyle}
						onClick={handleLoginClick}
						disabled={isLoading}
					>
						{isLoading ? "Logging in..." : "Login"}
					</button>

					<div style={dividerStyle}>or</div>

					<button
						type="button"
						style={secondaryButtonStyle}
						onClick={handleTokenPaste}
						disabled={isLoading}
					>
						Paste Token (Dev Only)
					</button>

					<p style={hintStyle}>
						This is a development login page. Authentication is verified against
						work.example.com.
					</p>
				</div>
			</div>
		</div>
	);
};

export default Login;
