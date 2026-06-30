import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	composeNotification,
	dismissNotification,
	fetchInbox,
	fetchPreferences,
	fetchUnreadCount,
	fetchUpcomingAlarms,
	markAllNotificationsRead,
	markNotificationRead,
	sendTestNotification,
	subscribeWebPush,
	unsubscribeWebPush,
	updatePreferences,
} from "../api/notifications";
import { useResourceLiveUpdates } from "./liveUpdates";

export const notificationKeys = {
	all: ["notifications"],
	preferences: ["notifications", "preferences"],
	upcoming: ["notifications", "upcoming"],
	inbox: (unreadOnly = false) => ["notifications", "inbox", { unreadOnly }],
	unreadCount: ["notifications", "unread-count"],
};

const INBOX_PAGE_SIZE = 20;

export const useNotificationPreferences = (options = {}) =>
	useQuery({
		queryKey: notificationKeys.preferences,
		queryFn: fetchPreferences,
		staleTime: 60_000,
		...options,
	});

export const useUpdateNotificationPreferences = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updatePreferences,
		onSuccess: (data) => {
			qc.setQueryData(notificationKeys.preferences, data);
		},
	});
};

export const useSubscribeWebPush = () =>
	useMutation({ mutationFn: subscribeWebPush });

export const useUnsubscribeWebPush = () =>
	useMutation({ mutationFn: unsubscribeWebPush });

export const useSendTestNotification = () =>
	useMutation({ mutationFn: sendTestNotification });

// Upcoming alerts for the in-app alarm scheduler. Polls so a tab left open
// picks up alerts created elsewhere. `enabled` lets callers gate on auth.
export const useUpcomingAlarms = ({
	withinMinutes = 180,
	enabled = true,
} = {}) =>
	useQuery({
		queryKey: notificationKeys.upcoming,
		queryFn: () => fetchUpcomingAlarms(withinMinutes),
		enabled,
		refetchInterval: 60_000,
		refetchIntervalInBackground: true,
		staleTime: 30_000,
	});

// ── In-app notification center (inbox / bell) ────────────────────────────────

// Paginated inbox (newest first). Cursor = the created_at of the last loaded
// item; a short page means no more pages.
export const useNotificationInbox = ({
	unreadOnly = false,
	enabled = true,
} = {}) =>
	useInfiniteQuery({
		queryKey: notificationKeys.inbox(unreadOnly),
		queryFn: ({ pageParam = null }) =>
			fetchInbox({ unreadOnly, before: pageParam, limit: INBOX_PAGE_SIZE }),
		initialPageParam: null,
		getNextPageParam: (lastPage) =>
			lastPage.length === INBOX_PAGE_SIZE
				? lastPage[lastPage.length - 1].created_at
				: undefined,
		enabled,
		staleTime: 15_000,
	});

// Unread count drives the bell badge. Refetches on focus + interval so
// notifications created by the (separate-process) workers surface without SSE.
export const useUnreadNotificationCount = ({ enabled = true } = {}) =>
	useQuery({
		queryKey: notificationKeys.unreadCount,
		queryFn: fetchUnreadCount,
		enabled,
		refetchInterval: 60_000,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: true,
		staleTime: 10_000,
	});

// Live badge/inbox updates for same-process events (e.g. manual compose). The
// generic SSE hook handles token refresh + reconnect; on any event we refetch
// the count and inbox lists.
export const useNotificationLiveUpdates = () => {
	const qc = useQueryClient();
	useResourceLiveUpdates({
		path: "/admin/notifications/events",
		event: "notification",
		queryKey: notificationKeys.all,
		onEvent: () => {
			qc.invalidateQueries({ queryKey: notificationKeys.unreadCount });
			qc.invalidateQueries({ queryKey: ["notifications", "inbox"] });
		},
	});
};

const invalidateInbox = (qc) => {
	qc.invalidateQueries({ queryKey: notificationKeys.unreadCount });
	qc.invalidateQueries({ queryKey: ["notifications", "inbox"] });
};

export const useMarkNotificationRead = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: markNotificationRead,
		onSuccess: () => invalidateInbox(qc),
	});
};

export const useMarkAllNotificationsRead = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: markAllNotificationsRead,
		onSuccess: () => invalidateInbox(qc),
	});
};

export const useDismissNotification = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: dismissNotification,
		onSuccess: () => invalidateInbox(qc),
	});
};

export const useComposeNotification = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: composeNotification,
		onSuccess: () => invalidateInbox(qc),
	});
};
