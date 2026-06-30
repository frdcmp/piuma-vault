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

// ── In-app notification center (inbox / bell) ────────────────────────────────

// One page of the inbox, newest first. `before` is the cursor (created_at of
// the last item already loaded). `unreadOnly` filters to unread.
export const fetchInbox = async ({
	unreadOnly = false,
	before = null,
	limit = 20,
} = {}) => {
	const { data } = await axiosInstance.get("/admin/notifications/inbox", {
		params: {
			unread_only: unreadOnly,
			before: before || undefined,
			limit,
		},
	});
	// [{ id, category, level, title, body, action_url, metadata, count, read_at, created_at }]
	return Array.isArray(data) ? data : [];
};

export const fetchUnreadCount = async () => {
	const { data } = await axiosInstance.get(
		"/admin/notifications/inbox/unread-count",
	);
	return data?.count ?? 0;
};

export const markNotificationRead = async (id) => {
	await axiosInstance.post(`/admin/notifications/inbox/${id}/read`);
};

export const markAllNotificationsRead = async () => {
	const { data } = await axiosInstance.post(
		"/admin/notifications/inbox/read-all",
	);
	return data; // { updated }
};

export const dismissNotification = async (id) => {
	await axiosInstance.delete(`/admin/notifications/inbox/${id}`);
};

// Manual compose — send a notification to yourself. payload:
// { title, body?, level?, action_url?, channels? (["web","push"]) }
export const composeNotification = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/notifications/inbox",
		payload,
	);
	return data; // { id }
};
