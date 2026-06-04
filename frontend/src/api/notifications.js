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

// Materialized alerts whose fire_at is within the near window — drives the
// in-app alarm (loud, must-dismiss overlay) while a tab is open. Recurrence /
// all-day / DST are already resolved server-side.
export const fetchUpcomingAlarms = async (withinMinutes = 180) => {
	const { data } = await axiosInstance.get("/admin/notifications/upcoming", {
		params: { within_minutes: withinMinutes },
	});
	// [{ id, source_type, source_id, occurrence_date, fire_at, offset_minutes, title, body }]
	return Array.isArray(data) ? data : [];
};
