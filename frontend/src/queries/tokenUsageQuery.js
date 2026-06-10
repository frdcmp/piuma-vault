import { useQuery } from "@tanstack/react-query";
import { getTokenUsage } from "../api/tokenUsage";

export const tokenUsageKeys = {
	all: ["tokenUsage"],
	list: (params) => [...tokenUsageKeys.all, "list", params || {}],
};

export const useTokenUsage = (params = {}, options = {}) =>
	useQuery({
		queryKey: tokenUsageKeys.list(params),
		queryFn: () => getTokenUsage(params),
		staleTime: 60 * 1000,
		...options,
	});
