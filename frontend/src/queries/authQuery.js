import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	postLogin,
	postLoginOtp,
	postRegister,
	postRequestPasswordReset,
	postResendVerification,
	postResetPassword,
	postVerifyEmail,
	setTrustedDeviceToken,
} from "../api/auth";

export const useLogin = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: postLogin,
		onSuccess: (data) => {
			// Step responses (verify_email_required, otp_required) don't carry tokens.
			if (!data?.access_token) return;
			localStorage.setItem("token", data.access_token);
			localStorage.setItem("refreshToken", data.refresh_token);
			queryClient.invalidateQueries({ queryKey: ["userMe"] });
		},
	});
};

export const useLoginOtp = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: postLoginOtp,
		onSuccess: (data) => {
			if (!data?.access_token) return;
			localStorage.setItem("token", data.access_token);
			localStorage.setItem("refreshToken", data.refresh_token);
			if (data.trusted_device_token) {
				setTrustedDeviceToken(data.trusted_device_token);
			}
			queryClient.invalidateQueries({ queryKey: ["userMe"] });
		},
	});
};

export const useRegister = () => {
	return useMutation({
		mutationFn: postRegister,
	});
};

export const useRequestPasswordReset = () => {
	return useMutation({
		mutationFn: postRequestPasswordReset,
	});
};

export const useResetPassword = () => {
	return useMutation({
		mutationFn: postResetPassword,
	});
};

export const useVerifyEmail = () => {
	return useMutation({
		mutationFn: postVerifyEmail,
	});
};

export const useResendVerification = () => {
	return useMutation({
		mutationFn: postResendVerification,
	});
};

export const useLogout = () => {
	const queryClient = useQueryClient();
	return () => {
		localStorage.removeItem("token");
		localStorage.removeItem("refreshToken");
		queryClient.setQueryData(["userMe"], null);
		queryClient.invalidateQueries({ queryKey: ["userMe"] });
		window.location.href = `${import.meta.env.BASE_URL}login`;
	};
};
