import { useQuery } from "@tanstack/react-query";
import { getTokenUsage } from "../api/tokenUsageApi";

export const tokenUsageKeys = {
	all: ["tokenUsage"],
	list: (params) => ["tokenUsage", "list", params || {}],
};

export const useTokenUsage = (params = {}, options = {}) =>
	useQuery({
		queryKey: tokenUsageKeys.list(params),
		queryFn: () => getTokenUsage(params),
		staleTime: 60_000,
		...options,
	});
