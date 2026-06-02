import axiosInstance from "./axiosInstance";

// ── Notifications: Web Push subscriptions, preferences, test ─────────────────

export const fetchVapidPublicKey = async () => {
	const { data } = await axiosInstance.get(
		"/admin/notifications/vapid-public-key",
	);
	return data.key;
};

export const subscribeWebPush = async (subscription) => {
	// `subscription` is the browser PushSubscription.toJSON() shape:
	// { endpoint, keys: { p256dh, auth } }
	await axiosInstance.post("/admin/notifications/web-push/subscribe", {
		endpoint: subscription.endpoint,
		keys: subscription.keys,
		user_agent: navigator.userAgent,
	});
};

export const unsubscribeWebPush = async (endpoint) => {
	await axiosInstance.delete("/admin/notifications/web-push/subscribe", {
		data: { endpoint },
	});
};

export const fetchPreferences = async () => {
	const { data } = await axiosInstance.get("/admin/notifications/preferences");
	return data; // { web_enabled, push_enabled }
};

export const updatePreferences = async (payload) => {
	// payload: { web?, push? }
	const { data } = await axiosInstance.put(
		"/admin/notifications/preferences",
		payload,
	);
	return data;
};

export const sendTestNotification = async () => {
	const { data } = await axiosInstance.post("/admin/notifications/test");
	return data; // { web_sent, push_sent }
};
