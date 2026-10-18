import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAppearance, updateAppearance } from "../api/appearance";

export const appearanceKeys = { all: ["appearance"] };

export const useAppearance = (options = {}) =>
	useQuery({
		queryKey: appearanceKeys.all,
		queryFn: getAppearance,
		staleTime: 5 * 60 * 1000,
		...options,
	});

export const useUpdateAppearance = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateAppearance,
		onSuccess: (data) => qc.setQueryData(appearanceKeys.all, data),
	});
};
