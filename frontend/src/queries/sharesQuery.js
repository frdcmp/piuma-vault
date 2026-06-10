import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	listAllShareLinks,
	renewShareLink,
	revokeShareLink,
	updateShareLink,
} from "../api/shares";

// Note shares across all notes — used by the central admin Shares page.
export const noteShareKeys = {
	all: ["noteShares", "all"],
};

export const useAllNoteShares = (options = {}) =>
	useQuery({
		queryKey: noteShareKeys.all,
		queryFn: listAllShareLinks,
		staleTime: 15_000,
		...options,
	});

export const useRevokeNoteShare = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: revokeShareLink,
		onSuccess: () => qc.invalidateQueries({ queryKey: noteShareKeys.all }),
	});
};

export const useUpdateNoteShare = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, updates }) => updateShareLink(id, updates),
		onSuccess: () => qc.invalidateQueries({ queryKey: noteShareKeys.all }),
	});
};

export const useRenewNoteShare = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: renewShareLink,
		onSuccess: () => qc.invalidateQueries({ queryKey: noteShareKeys.all }),
	});
};
