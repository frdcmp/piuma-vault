import axios from "axios";
import { queryClient } from "./queryClient";

// Configuration - centralized base path
const BASE_PATH = `${import.meta.env.BASE_URL}api/v1`; // Adjust as needed for different environments

// Create axios instance for internal backend API
const axiosInstance = axios.create({
	baseURL: BASE_PATH,
	timeout: 120000, // 2 minutes - increased for TTS operations that can take longer
	headers: {
		"Content-Type": "application/json",
	},
});

let __axiosRequestCounter = 0;
function _nextRequestId() {
	__axiosRequestCounter += 1;
	return `req_${Date.now()}_${__axiosRequestCounter}`;
}

// Request interceptor to add auth token
axiosInstance.interceptors.request.use(
	(config) => {
		const token = localStorage.getItem("token");

		const requestId = _nextRequestId();
		config._requestId = requestId;
		config.metadata = { startTime: new Date() };

		const from =
			typeof window !== "undefined" ? window.location.href : "unknown";
		const to = `${config.baseURL || axiosInstance.defaults.baseURL || ""}${config.url || ""}`;

		console.info(
			`[Axios][Request][${requestId}] ${config.method?.toUpperCase() || "GET"} ${to} from ${from}`,
		);

		if (token) {
			config.headers.Authorization = `Bearer ${token}`;
		}

		return config;
	},
	(error) => {
		return Promise.reject(error);
	},
);

// Flag to prevent multiple refreshes
let isRefreshing = false;
// Queue to hold requests while refreshing
let failedQueue = [];

const processQueue = (error, token = null) => {
	failedQueue.forEach((prom) => {
		if (error) {
			prom.reject(error);
		} else {
			prom.resolve(token);
		}
	});

	failedQueue = [];
};

// Response interceptor with automatic token refresh handling
axiosInstance.interceptors.response.use(
	(response) => {
		try {
			const reqId = response.config?._requestId;
			const start = response.config?.metadata?.startTime;
			const duration = start ? `${Date.now() - start}ms` : "n/a";
			const from =
				typeof window !== "undefined" ? window.location.href : "unknown";
			const to = `${response.config?.baseURL || axiosInstance.defaults.baseURL || ""}${response.config?.url || ""}`;
			if (reqId) {
				console.info(
					`[Axios][Response][${reqId}] ${response.status} ${response.config.method?.toUpperCase() || "GET"} ${to} from ${from} duration ${duration}`,
				);
			}
		} catch (_e) {
			// ignore logging errors
		}
		return response;
	},
	async (error) => {
		const originalRequest = error.config || {};

		const errReqId = originalRequest._requestId || `req_err_${Date.now()}`;
		const from =
			typeof window !== "undefined" ? window.location.href : "unknown";
		const to = `${originalRequest.baseURL || axiosInstance.defaults.baseURL || ""}${originalRequest.url || ""}`;
		const duration = originalRequest.metadata?.startTime
			? `${Date.now() - originalRequest.metadata.startTime}ms`
			: "n/a";

		console.warn(
			`[Axios][Error][${errReqId}] ${error.response?.status || "NO_STATUS"} ${originalRequest.method?.toUpperCase() || ""} ${to} from ${from} duration ${duration}`,
		);

		// STEP 1: Check if we received a 401 Unauthorized error and haven't already tried to refresh
		if (error.response?.status === 401 && !originalRequest._retry) {
			if (isRefreshing) {
				return new Promise((resolve, reject) => {
					failedQueue.push({ resolve, reject });
				})
					.then((token) => {
						originalRequest.headers.Authorization = `Bearer ${token}`;
						return axiosInstance(originalRequest);
					})
					.catch((err) => {
						return Promise.reject(err);
					});
			}

			// STEP 2: Mark this request as having attempted refresh to prevent infinite loops
			originalRequest._retry = true;
			isRefreshing = true;

			// STEP 3: Check if we have a refresh token in localStorage
			const refreshToken = localStorage.getItem("refreshToken");
			if (refreshToken) {
				try {
					// STEP 4: Call the backend to refresh both tokens
					const refreshResponse = await axios.post(
						`${BASE_PATH}/auth/refresh`,
						{
							refresh_token: refreshToken,
						},
						{
							headers: {
								"Content-Type": "application/json",
							},
						},
					);

					// STEP 5: Check if refresh was successful
					if (refreshResponse.status === 200) {
						// STEP 6: Extract both new tokens from response (token rotation security)
						const newAccessToken = refreshResponse.data.access_token;
						const newRefreshToken = refreshResponse.data.refresh_token;

						// STEP 7: Update localStorage with both new tokens
						localStorage.setItem("token", newAccessToken);
						localStorage.setItem("refreshToken", newRefreshToken);

						// Update defaults
						axiosInstance.defaults.headers.common.Authorization = `Bearer ${newAccessToken}`;

						// Force refetch of user profile to keep app state consistent
						queryClient.invalidateQueries({ queryKey: ["userMe"] });

						// Process queued requests
						processQueue(null, newAccessToken);
						isRefreshing = false;

						// STEP 8: Update the original failed request with the new access token
						originalRequest.headers = originalRequest.headers || {};
						originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;

						// log retry
						const retryFrom =
							typeof window !== "undefined" ? window.location.href : "unknown";
						const retryTo = `${originalRequest.baseURL || axiosInstance.defaults.baseURL || ""}${originalRequest.url || ""}`;
						console.info(
							`[Axios][Retry][${originalRequest._requestId}] Retrying ${originalRequest.method?.toUpperCase() || "GET"} ${retryTo} from ${retryFrom}`,
						);

						// STEP 9: Retry the original request that failed due to expired token
						return axiosInstance(originalRequest);
					}
				} catch (refreshError) {
					// STEP 10: Refresh failed - clear all tokens and redirect to login
					processQueue(refreshError, null);
					isRefreshing = false;

					localStorage.removeItem("token");
					localStorage.removeItem("refreshToken");
					console.error(
						`[Axios][RefreshFailed][${originalRequest._requestId}] refresh failed:`,
						refreshError,
					);
					const currentPath = window.location.pathname + window.location.search;
					window.location.href = `${import.meta.env.BASE_URL}settings/login?redirectTo=${encodeURIComponent(currentPath)}`;
					return Promise.reject(refreshError);
				}
			} else {
				// STEP 11: No refresh token available - redirect to login
				isRefreshing = false;
				console.info(
					`[Axios][NoRefreshToken][${originalRequest._requestId}] redirecting to login from ${from}`,
				);
				const currentPath = window.location.pathname + window.location.search;
				window.location.href = `${import.meta.env.BASE_URL}settings/login?redirectTo=${encodeURIComponent(currentPath)}`;
			}
		}

		// STEP 12: For all other errors or if refresh already attempted, reject the promise
		return Promise.reject(error);
	},
);

export { axiosInstance };
export default axiosInstance;
