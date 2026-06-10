import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getScreenLock, updateScreenLock } from "../api/screenLockApi";

const SCREEN_LOCK_KEY = ["screen-lock"];

// Reads the global screen-lock config (enabled / timeout / pin_set).
export const useScreenLockSettings = (options = {}) =>
	useQuery({
		queryKey: SCREEN_LOCK_KEY,
		queryFn: getScreenLock,
		staleTime: 60_000,
		...options,
	});

// Update the config (enable toggle, timeout, or PIN). The PUT returns the fresh
// config, so seed the cache directly — ScreenLockGate reacts to it immediately.
export const useUpdateScreenLock = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateScreenLock,
		onSuccess: (data) => {
			qc.setQueryData(SCREEN_LOCK_KEY, data);
		},
	});
};
