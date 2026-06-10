import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchUserMe, updateUserProfile } from "../api/userApi";
import { useAuthStore } from "../stores/authStore";

export const userKeys = {
	me: ["user", "me"],
};

// The signed-in user + profile. Only runs while authenticated.
export const useUserMe = (options = {}) => {
	const token = useAuthStore((s) => s.token);
	return useQuery({
		queryKey: userKeys.me,
		queryFn: fetchUserMe,
		enabled: !!token,
		staleTime: 5 * 60 * 1000,
		retry: false,
		...options,
	});
};

export const useUpdateProfile = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateUserProfile,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: userKeys.me });
		},
	});
};
