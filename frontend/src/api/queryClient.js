import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// Data is considered fresh forever unless explicitly invalidated.
			// This prevents automatic refetching on window focus, mount, etc.
			// if the data is already in the cache.
			staleTime: Infinity,

			// Keep unused data in cache for 10 minutes before garbage collection
			gcTime: 10 * 60 * 1000,

			// Do not refetch on window focus if data is fresh (which is always true with staleTime: Infinity)
			refetchOnWindowFocus: false,

			// Do not refetch on reconnect if data is fresh
			refetchOnReconnect: false,

			// Do not refetch on mount if data is fresh
			refetchOnMount: false,
		},
	},
});
