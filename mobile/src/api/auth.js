import axiosInstance, { refreshAccessToken } from "./axiosInstance";
import { useAuthStore } from "../stores/authStore";

export { refreshAccessToken };

export const postLogin = async ({ email, password }) => {
	const trusted_device_token = useAuthStore.getState().trustedDeviceToken;
	const { data } = await axiosInstance.post("/auth/login", {
		email,
		password,
		...(trusted_device_token ? { trusted_device_token } : {}),
	});
	return data;
};

export const postLoginOtp = async ({
	otp_session,
	code,
	trust_device,
	device_label,
}) => {
	const { data } = await axiosInstance.post("/auth/login/otp", {
		otp_session,
		code,
		trust_device: !!trust_device,
		...(device_label ? { device_label } : {}),
	});
	return data;
};

export const postRegister = async ({ email, password }) => {
	const { data } = await axiosInstance.post("/auth/register", {
		email,
		password,
	});
	return data;
};

export const postTokenRefresh = async ({ refresh_token }) => {
	const { data } = await axiosInstance.post("/auth/refresh", { refresh_token });
	return data;
};

export const postRequestPasswordReset = async ({ email }) => {
	const { data } = await axiosInstance.post("/auth/request-password-reset", {
		email,
	});
	return data;
};

export const postResetPassword = async ({ token, new_password }) => {
	const { data } = await axiosInstance.post("/auth/reset-password", {
		token,
		new_password,
	});
	return data;
};

export const postVerifyEmail = async ({ token }) => {
	const { data } = await axiosInstance.get("/auth/verify", {
		params: { token },
	});
	return data;
};

export const postResendVerification = async ({ email }) => {
	const { data } = await axiosInstance.post("/auth/resend-verification", {
		email,
	});
	return data;
};
