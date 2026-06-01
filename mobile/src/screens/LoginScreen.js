import { useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { postLogin, postLoginOtp, postResendVerification } from "../api/auth";
import { TOP_EXTRA } from "../components/SystemBars";
import { useAuthStore } from "../stores/authStore";
import { colors } from "../utils/theme";

const RESEND_COOLDOWN = 30; // seconds

export default function LoginScreen() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [formError, setFormError] = useState(null);

	// OTP second-step state. otp_session is held in memory only — it's
	// short-lived and authorizes only the next /auth/login/otp call.
	const [otpSession, setOtpSession] = useState(null);
	const [otpCode, setOtpCode] = useState("");
	const [trustDevice, setTrustDevice] = useState(false);

	// Resend-verification flow
	const [unverifiedEmail, setUnverifiedEmail] = useState(null);
	const [resendSuccess, setResendSuccess] = useState(false);
	const [resendPending, setResendPending] = useState(false);
	const [cooldown, setCooldown] = useState(0);
	const timerRef = useRef(null);

	const setAuth = useAuthStore((state) => state.setAuth);

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

	const handleResend = async () => {
		if (!unverifiedEmail || cooldown > 0 || resendPending) return;
		setResendSuccess(false);
		setResendPending(true);
		try {
			await postResendVerification({ email: unverifiedEmail });
			setResendSuccess(true);
			startCooldown();
		} catch (err) {
			const body = err.response?.data;
			setFormError(
				(typeof body === "string" ? body : null) ||
					body?.error ||
					err.message ||
					"Failed to resend verification email",
			);
		} finally {
			setResendPending(false);
		}
	};

	const resetToCreds = () => {
		setOtpSession(null);
		setOtpCode("");
		setFormError(null);
	};

	const handleLogin = async () => {
		if (!email || !password) {
			setFormError("Please enter both email and password.");
			return;
		}

		setLoading(true);
		setFormError(null);
		setUnverifiedEmail(null);
		setResendSuccess(false);

		try {
			const data = await postLogin({ email, password });

			if (data?.step === "verify_email_required") {
				setUnverifiedEmail(data.email || email);
				return;
			}
			if (data?.step === "otp_required") {
				setOtpSession(data.otp_session);
				setOtpCode("");
				return;
			}
			if (data?.access_token) {
				await setAuth({
					accessToken: data.access_token,
					refreshToken: data.refresh_token,
					user: data.user,
				});
				return;
			}
			setFormError("Login failed: No token received");
		} catch (err) {
			const status = err.response?.status;
			const body = err.response?.data;
			console.error("[login] failed", { status, body, message: err.message });
			setFormError(
				body?.message ||
					body?.error ||
					(typeof body === "string" ? body : null) ||
					(status
						? `Login failed (HTTP ${status})`
						: err.message || "Invalid credentials"),
			);
		} finally {
			setLoading(false);
		}
	};

	const handleOtp = async () => {
		if (!otpSession) return;
		const trimmed = (otpCode || "").trim();
		if (!trimmed) {
			setFormError("Enter the code from your authenticator app.");
			return;
		}
		setLoading(true);
		setFormError(null);
		try {
			const deviceLabel = `${Platform.OS} ${Platform.Version || ""}`.trim();
			const data = await postLoginOtp({
				otp_session: otpSession,
				code: trimmed,
				trust_device: trustDevice,
				device_label: deviceLabel,
			});
			if (!data?.access_token) {
				setFormError("Unexpected response from server.");
				return;
			}
			await setAuth({
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				user: data.user,
				trustedDeviceToken: data.trusted_device_token || undefined,
			});
		} catch (err) {
			const status = err.response?.status;
			const body = err.response?.data;
			console.error("[login-otp] failed", {
				status,
				body,
				message: err.message,
			});
			if (
				body === "Invalid or expired session" ||
				(status === 401 && body !== "Invalid code")
			) {
				setOtpSession(null);
				setFormError("Session expired. Please log in again.");
				return;
			}
			setFormError(
				(typeof body === "string" ? body : null) ||
					body?.error ||
					err.message ||
					"Invalid code",
			);
		} finally {
			setLoading(false);
		}
	};

	return (
		<SafeAreaView style={styles.safeArea}>
			<KeyboardAvoidingView
				style={{ flex: 1 }}
				behavior={Platform.OS === "ios" ? "padding" : undefined}
			>
				<ScrollView
					contentContainerStyle={styles.scrollContent}
					keyboardShouldPersistTaps="handled"
				>
					<View style={styles.cardWrapper}>
						{/* Pixel-style offset block shadow */}
						<View style={styles.cardShadow} />

						<View style={styles.card}>
							{/* Yellow corner pixels */}
							<View style={[styles.cornerPixel, styles.cornerTopLeft]} />
							<View style={[styles.cornerPixel, styles.cornerBottomRight]} />

							<Text style={styles.title}>Login</Text>
							<Text style={styles.subtitle}>
								Welcome back! Please login to your account.
							</Text>

							{formError ? (
								<View style={styles.alert}>
									<Text style={styles.alertTitle}>⚠ Login Failed</Text>
									<Text style={styles.alertText}>{formError}</Text>
								</View>
							) : null}

							{unverifiedEmail ? (
								<View style={[styles.alert, styles.alertWarning]}>
									<Text style={[styles.alertTitle, styles.alertTitleWarning]}>
										⚠ Email not verified
									</Text>
									<Text style={[styles.alertText, { marginBottom: 12 }]}>
										Please verify your email address before logging in.
									</Text>
									{resendSuccess ? (
										<Text style={styles.resendSuccess}>
											Verification email sent! Check your inbox.
										</Text>
									) : null}
									<Pressable
										onPress={handleResend}
										disabled={cooldown > 0 || resendPending}
										style={({ pressed }) => [
											styles.btn,
											styles.btnSmall,
											(cooldown > 0 || resendPending) && styles.btnDisabled,
											pressed &&
												!cooldown &&
												!resendPending &&
												styles.btnPressed,
										]}
									>
										<Text style={[styles.btnText, styles.btnTextSmall]}>
											{resendPending
												? "Sending..."
												: cooldown > 0
													? `Resend in ${cooldown}s`
													: "Resend verification email"}
										</Text>
									</Pressable>
								</View>
							) : null}

							{!otpSession ? (
								<>
									<View style={styles.formGroup}>
										<View style={styles.inputWrapper}>
											<Text style={styles.inputIcon}>@</Text>
											<TextInput
												style={styles.input}
												placeholder="Email"
												placeholderTextColor={colors.muted}
												value={email}
												onChangeText={setEmail}
												autoCapitalize="none"
												keyboardType="email-address"
												autoComplete="email"
											/>
										</View>
									</View>

									<View style={[styles.formGroup, { marginBottom: 12 }]}>
										<View style={styles.inputWrapper}>
											<Text style={styles.inputIcon}>**</Text>
											<TextInput
												style={styles.input}
												placeholder="Password"
												placeholderTextColor={colors.muted}
												value={password}
												onChangeText={setPassword}
												secureTextEntry
												autoComplete="password"
											/>
										</View>
									</View>

									<View style={styles.forgotRow}>
										<Text style={styles.forgotLink}>Forgot password?</Text>
									</View>

									<Pressable
										onPress={handleLogin}
										disabled={loading}
										style={({ pressed }) => [
											styles.btn,
											styles.btnPrimary,
											loading && styles.btnDisabled,
											pressed && !loading && styles.btnPressed,
										]}
									>
										{loading ? (
											<ActivityIndicator color={colors.accent2} />
										) : (
											<Text style={[styles.btnText, styles.btnTextPrimary]}>
												Log in
											</Text>
										)}
									</Pressable>
								</>
							) : null}

							{otpSession ? (
								<>
									<Text style={[styles.subtitle, { marginBottom: 16 }]}>
										Enter the 6-digit code from your authenticator app, or a
										backup code if you've lost the device.
									</Text>

									<View style={styles.formGroup}>
										<View style={styles.inputWrapper}>
											<Text style={styles.inputIcon}>#</Text>
											<TextInput
												style={styles.input}
												placeholder="123456"
												placeholderTextColor={colors.muted}
												value={otpCode}
												onChangeText={setOtpCode}
												autoCapitalize="none"
												keyboardType="number-pad"
												autoFocus
												textContentType="oneTimeCode"
												maxLength={20}
											/>
										</View>
									</View>

									<View style={styles.trustRow}>
										<Switch
											value={trustDevice}
											onValueChange={setTrustDevice}
											thumbColor={trustDevice ? colors.accent : "#666"}
											trackColor={{ true: "#5a4a1f", false: "#333" }}
										/>
										<Text style={styles.trustLabel}>
											Trust this device for 30 days
										</Text>
									</View>

									<Pressable
										onPress={handleOtp}
										disabled={loading}
										style={({ pressed }) => [
											styles.btn,
											styles.btnPrimary,
											loading && styles.btnDisabled,
											pressed && !loading && styles.btnPressed,
										]}
									>
										{loading ? (
											<ActivityIndicator color={colors.accent2} />
										) : (
											<Text style={[styles.btnText, styles.btnTextPrimary]}>
												Verify
											</Text>
										)}
									</Pressable>

									<Pressable onPress={resetToCreds} style={styles.backLinkWrap}>
										<Text style={styles.backLink}>← Back to login</Text>
									</Pressable>
								</>
							) : null}
						</View>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "JetBrains Mono, Menlo, Courier New, monospace",
});

const styles = StyleSheet.create({
	safeArea: {
		flex: 1,
		backgroundColor: colors.bg,
		paddingTop: TOP_EXTRA,
	},
	scrollContent: {
		flexGrow: 1,
		justifyContent: "center",
		alignItems: "center",
		padding: 16,
	},
	cardWrapper: {
		width: "100%",
		maxWidth: 340,
		position: "relative",
	},
	cardShadow: {
		position: "absolute",
		top: 4,
		left: 4,
		right: -4,
		bottom: -4,
		backgroundColor: "#000",
	},
	card: {
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		padding: 24,
		paddingVertical: 32,
		position: "relative",
	},
	cornerPixel: {
		position: "absolute",
		width: 6,
		height: 6,
		backgroundColor: colors.accent,
	},
	cornerTopLeft: {
		top: -4,
		left: -4,
	},
	cornerBottomRight: {
		bottom: -4,
		right: -4,
	},
	title: {
		fontFamily: MONO,
		fontSize: 24,
		fontWeight: "700",
		color: colors.accent,
		textAlign: "center",
		marginBottom: 8,
		textShadowColor: "#000",
		textShadowOffset: { width: 2, height: 2 },
		textShadowRadius: 0,
	},
	subtitle: {
		fontFamily: MONO,
		color: colors.muted,
		textAlign: "center",
		fontSize: 14,
		marginBottom: 24,
	},
	alert: {
		borderWidth: 2,
		borderColor: colors.accent3,
		backgroundColor: "rgba(255, 107, 107, 0.1)",
		padding: 12,
		marginBottom: 24,
	},
	alertWarning: {
		borderColor: colors.accent,
		backgroundColor: "rgba(247, 201, 72, 0.1)",
	},
	alertTitle: {
		fontFamily: MONO,
		fontWeight: "bold",
		fontSize: 14,
		marginBottom: 4,
		color: colors.accent3,
	},
	alertTitleWarning: {
		color: colors.accent,
	},
	alertText: {
		fontFamily: MONO,
		color: colors.text,
		fontSize: 14,
	},
	resendSuccess: {
		fontFamily: MONO,
		color: colors.accent2,
		fontSize: 13,
		marginBottom: 12,
	},
	formGroup: {
		marginBottom: 16,
	},
	inputWrapper: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: colors.bg,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 12,
	},
	inputIcon: {
		fontFamily: MONO,
		color: colors.muted,
		marginRight: 8,
		fontSize: 14,
	},
	input: {
		flex: 1,
		backgroundColor: "transparent",
		color: colors.text,
		paddingVertical: 12,
		fontFamily: MONO,
		fontSize: 14,
	},
	forgotRow: {
		alignItems: "flex-end",
		marginBottom: 24,
	},
	forgotLink: {
		fontFamily: MONO,
		color: colors.accent4,
		fontSize: 12,
	},
	btn: {
		width: "100%",
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingVertical: 12,
		paddingHorizontal: 12,
		alignItems: "center",
		justifyContent: "center",
	},
	btnPrimary: {
		borderColor: colors.accent2,
	},
	btnSmall: {
		paddingVertical: 8,
	},
	btnDisabled: {
		opacity: 0.5,
	},
	btnPressed: {
		transform: [{ translateX: 1 }, { translateY: 1 }],
	},
	btnText: {
		fontFamily: MONO,
		fontSize: 16,
		fontWeight: "bold",
		color: colors.text,
	},
	btnTextPrimary: {
		color: colors.accent2,
	},
	btnTextSmall: {
		fontSize: 12,
	},
	trustRow: {
		flexDirection: "row",
		alignItems: "center",
		marginBottom: 16,
	},
	trustLabel: {
		fontFamily: MONO,
		color: colors.text,
		marginLeft: 12,
		fontSize: 12,
	},
	backLinkWrap: {
		alignItems: "center",
		marginTop: 12,
	},
	backLink: {
		fontFamily: MONO,
		color: colors.accent4,
		fontSize: 12,
	},
});
