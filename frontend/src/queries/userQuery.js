import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchUserMe, updateUserProfile } from "../api/user";

export const useUserMe = () => {
	return useQuery({
		queryKey: ["userMe"],
		queryFn: fetchUserMe,
		// Auth failures (401/403) are terminal — the axios interceptor already
		// attempted a token refresh, so retrying would only loop. Anything else
		// (network error, 5xx, nginx stale-upstream 502 during a backend reload)
		// is transient: retry a few times so a blip doesn't bounce a live session
		// to /admin/login.
		retry: (failureCount, error) => {
			const status = error?.response?.status;
			if (status === 401 || status === 403) return false;
			return failureCount < 3;
		},
		staleTime: 1000 * 60 * 5,
		enabled:
			!!localStorage.getItem("token") || !!localStorage.getItem("refreshToken"),
	});
};

export const useUpdateProfile = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: updateUserProfile,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["userMe"] });
		},
	});
};
