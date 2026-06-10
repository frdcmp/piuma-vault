import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchUserMe, updateUserProfile } from "../api/user";

export const useUserMe = () => {
	return useQuery({
		queryKey: ["userMe"],
		queryFn: fetchUserMe,
		retry: false,
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
