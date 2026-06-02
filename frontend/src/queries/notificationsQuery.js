import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fetchPreferences,
	sendTestNotification,
	subscribeWebPush,
	unsubscribeWebPush,
	updatePreferences,
} from "../api/notifications";

export const notificationKeys = {
	all: ["notifications"],
	preferences: ["notifications", "preferences"],
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
