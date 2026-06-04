import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fetchPreferences,
	fetchUpcomingAlarms,
	sendTestNotification,
	subscribeWebPush,
	unsubscribeWebPush,
	updatePreferences,
} from "../api/notifications";

export const notificationKeys = {
	all: ["notifications"],
	preferences: ["notifications", "preferences"],
	upcoming: ["notifications", "upcoming"],
};

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
