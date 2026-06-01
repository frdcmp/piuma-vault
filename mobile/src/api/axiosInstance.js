import axios from "axios";
import { useAuthStore } from "../stores/authStore";

const BASE_PATH =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

console.log("[axios] baseURL =", BASE_PATH);

const axiosInstance = axios.create({
	baseURL: BASE_PATH,
	timeout: 30000,
	headers: {
		"Content-Type": "application/json",
	},
});

axiosInstance.interceptors.request.use(
	(config) => {
		const token = useAuthStore.getState().token;
		if (token) {
			config.headers.Authorization = `Bearer ${token}`;
		}
		console.log(
			"[axios] →",
			(config.method || "get").toUpperCase(),
			(config.baseURL || "") + (config.url || ""),
			token ? "(auth)" : "(no auth)",
		);
		return config;
	},
	(error) => {
		console.error("[axios] request error", error);
		return Promise.reject(error);
	},
);

// Single-flight refresh: while one refresh is in flight, queue any other
// 401 retries so we don't hammer /auth/refresh with parallel calls.
let refreshPromise = null;

export const refreshAccessToken = async () => {
	const { getRefreshToken, setAuth } = useAuthStore.getState();
	const refreshToken = getRefreshToken();
	if (!refreshToken) throw new Error("no refresh token");

	// Use a bare axios call so this request doesn't re-enter our interceptors.
	const { data } = await axios.post(
		`${BASE_PATH}/auth/refresh`,
		{ refresh_token: refreshToken },
		{ headers: { "Content-Type": "application/json" }, timeout: 30000 },
	);
	if (!data?.access_token) throw new Error("refresh returned no access_token");
	await setAuth({
		accessToken: data.access_token,
		refreshToken: data.refresh_token || refreshToken,
		user: data.user,
	});
	return data.access_token;
};

axiosInstance.interceptors.response.use(
	(response) => {
		console.log("[axios] ←", response.status, response.config?.url);
		return response;
	},
	async (error) => {
		const original = error.config;
		const status = error.response?.status;

		// Try refresh once, only for 401s on non-auth endpoints with a refresh token available.
		const isAuthCall = original?.url?.includes("/auth/");
		const canRefresh =
			status === 401 &&
			!original?._retried &&
			!isAuthCall &&
			useAuthStore.getState().refreshToken;

		if (canRefresh) {
			original._retried = true;
			try {
				if (!refreshPromise) {
					console.log("[axios] 401 → refreshing access token");
					refreshPromise = refreshAccessToken().finally(() => {
						refreshPromise = null;
					});
				}
				const newToken = await refreshPromise;
				original.headers = {
					...(original.headers || {}),
					Authorization: `Bearer ${newToken}`,
				};
				return axiosInstance(original);
			} catch (refreshErr) {
				console.error(
					"[axios] refresh failed, logging out",
					refreshErr?.response?.status,
					refreshErr?.message,
				);
				await useAuthStore.getState().logout();
				return Promise.reject(error);
			}
		}

		if (error.response) {
			console.error(
				"[axios] ✗",
				error.response.status,
				error.config?.url,
				error.response.data,
			);
		} else if (error.request) {
			console.error(
				"[axios] ✗ no response (network/CORS/timeout)",
				error.config?.url,
				error.message,
			);
		} else {
			console.error("[axios] ✗ setup error", error.message);
		}
		return Promise.reject(error);
	},
);

export default axiosInstance;
