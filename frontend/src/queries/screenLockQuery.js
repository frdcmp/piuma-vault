import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getScreenLock, updateScreenLock } from "../api/screenLock";

const SCREEN_LOCK_KEY = ["screen-lock"];

export const useScreenLockSettings = (options = {}) =>
	useQuery({
		queryKey: SCREEN_LOCK_KEY,
		queryFn: getScreenLock,
		...options,
	});

export const useUpdateScreenLock = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateScreenLock,
		onSuccess: (data) => {
			// The PUT returns the fresh config — seed the cache directly.
			qc.setQueryData(SCREEN_LOCK_KEY, data);
		},
	});
};
