import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	confirmMemoryEntry,
	deleteMemoryEntry,
	getMemoryOverview,
	listMemoryEntries,
	rejectMemoryEntry,
} from "../api/memoryApi";

export const memoryKeys = {
	all: ["memory"],
	overview: (agent) => ["memory", "overview", agent],
	entries: (filters) => ["memory", "entries", filters || {}],
};

export const useMemoryOverview = (agent = "vault_agent", options = {}) =>
	useQuery({
		queryKey: memoryKeys.overview(agent),
		queryFn: () => getMemoryOverview(agent),
		staleTime: 60_000,
		...options,
	});

// Paginated entries. The backend returns `pageSize` rows per offset; a short
// page means we've hit the end. Moderation mutations invalidate ["memory"], so
// the loaded pages refetch in place after a confirm/reject/delete.
export const useMemoryEntriesInfinite = (
	filters = {},
	pageSize = 30,
	options = {},
) =>
	useInfiniteQuery({
		queryKey: ["memory", "entries-infinite", filters || {}, pageSize],
		queryFn: ({ pageParam }) =>
			listMemoryEntries({ ...filters, limit: pageSize, offset: pageParam }),
		initialPageParam: 0,
		getNextPageParam: (lastPage, allPages) =>
			lastPage.length === pageSize ? allPages.length * pageSize : undefined,
		staleTime: 30_000,
		...options,
	});

// Moderation — each refreshes the entries list and overview counts.
const useModerationMutation = (mutationFn) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: memoryKeys.all });
		},
	});
};

export const useConfirmMemoryEntry = () =>
	useModerationMutation(confirmMemoryEntry);
export const useRejectMemoryEntry = () =>
	useModerationMutation(rejectMemoryEntry);
export const useDeleteMemoryEntry = () =>
	useModerationMutation(deleteMemoryEntry);
