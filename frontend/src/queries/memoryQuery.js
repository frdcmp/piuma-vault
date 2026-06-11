import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	confirmMemoryEntry,
	deleteMemoryEntry,
	getEntryStats,
	getMemoryOverview,
	listMemoryEntries,
	listTurnLogs,
	rejectMemoryEntry,
	searchConversations,
} from "../api/memory";

export const memoryKeys = {
	all: ["memory"],
	overview: (agent) => [...memoryKeys.all, "overview", agent],
	entries: (filters) => [...memoryKeys.all, "entries", filters],
	entryStats: (id) => [...memoryKeys.all, "entryStats", id],
	turnLogs: (filters) => [...memoryKeys.all, "turnLogs", filters],
	conversations: (filters) => [...memoryKeys.all, "conversations", filters],
};

export const useMemoryOverview = (agent = "vault_agent", options = {}) =>
	useQuery({
		queryKey: memoryKeys.overview(agent),
		queryFn: () => getMemoryOverview(agent),
		staleTime: 30 * 1000,
		...options,
	});

export const useMemoryEntries = (filters = {}, options = {}) =>
	useQuery({
		queryKey: memoryKeys.entries(filters),
		queryFn: () => listMemoryEntries(filters),
		staleTime: 30 * 1000,
		...options,
	});

/** Per-entry corroboration metrics. Lazy — only fetched when a row expands. */
export const useEntryStats = (id, options = {}) =>
	useQuery({
		queryKey: memoryKeys.entryStats(id),
		queryFn: () => getEntryStats(id),
		staleTime: 30 * 1000,
		...options,
	});

export const useTurnLogs = (filters = {}, options = {}) =>
	useQuery({
		queryKey: memoryKeys.turnLogs(filters),
		queryFn: () => listTurnLogs(filters),
		staleTime: 30 * 1000,
		...options,
	});

export const useSearchConversations = (filters = {}, options = {}) =>
	useQuery({
		queryKey: memoryKeys.conversations(filters),
		queryFn: () => searchConversations(filters),
		staleTime: 30 * 1000,
		...options,
	});

/** Invalidate every memory query after a mutation (entries + overview). */
const useInvalidateMemory = () => {
	const qc = useQueryClient();
	return () => qc.invalidateQueries({ queryKey: memoryKeys.all });
};

export const useConfirmMemoryEntry = () => {
	const invalidate = useInvalidateMemory();
	return useMutation({ mutationFn: confirmMemoryEntry, onSuccess: invalidate });
};

export const useRejectMemoryEntry = () => {
	const invalidate = useInvalidateMemory();
	return useMutation({ mutationFn: rejectMemoryEntry, onSuccess: invalidate });
};

export const useDeleteMemoryEntry = () => {
	const invalidate = useInvalidateMemory();
	return useMutation({ mutationFn: deleteMemoryEntry, onSuccess: invalidate });
};
