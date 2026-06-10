import { useQuery } from "@tanstack/react-query";
import { getScreenLock } from "../api/screenLockApi";

// Reads the global screen-lock config (enabled / timeout). Configured on web.
export const useScreenLockSettings = (options = {}) =>
	useQuery({
		queryKey: ["screen-lock"],
		queryFn: getScreenLock,
		staleTime: 60_000,
		...options,
	});
