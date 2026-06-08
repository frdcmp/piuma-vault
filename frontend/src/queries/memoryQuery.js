import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	confirmMemoryEntry,
	deleteMemoryEntry,
	getMemoryOverview,
	listMemoryEntries,
	listTurnLogs,
	rejectMemoryEntry,
} from "../api/memory";

export const memoryKeys = {
	all: ["memory"],
	overview: (agent) => [...memoryKeys.all, "overview", agent],
	entries: (filters) => [...memoryKeys.all, "entries", filters],
	turnLogs: (filters) => [...memoryKeys.all, "turnLogs", filters],
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

export const useTurnLogs = (filters = {}, options = {}) =>
	useQuery({
		queryKey: memoryKeys.turnLogs(filters),
		queryFn: () => listTurnLogs(filters),
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
