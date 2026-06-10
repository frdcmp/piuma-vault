import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFolderShare,
	deleteFolderShare,
	listFolderShares,
	renewFolderShare,
	updateFolderShare,
} from "../api/folderShares";

export const folderShareKeys = {
	all: ["folderShares"],
	list: (prefix) => ["folderShares", "list", prefix || ""],
};

// Admin: shares for a given folder prefix (or all when prefix is falsy).
export const useFolderShares = (prefix, options = {}) =>
	useQuery({
		queryKey: folderShareKeys.list(prefix),
		queryFn: () => listFolderShares(prefix),
		staleTime: 15_000,
		...options,
	});

export const useCreateFolderShare = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createFolderShare,
		onSuccess: () => qc.invalidateQueries({ queryKey: folderShareKeys.all }),
	});
};

export const useUpdateFolderShare = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...updates }) => updateFolderShare(id, updates),
		onSuccess: () => qc.invalidateQueries({ queryKey: folderShareKeys.all }),
	});
};

export const useDeleteFolderShare = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteFolderShare,
		onSuccess: () => qc.invalidateQueries({ queryKey: folderShareKeys.all }),
	});
};

export const useRenewFolderShare = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: renewFolderShare,
		onSuccess: () => qc.invalidateQueries({ queryKey: folderShareKeys.all }),
	});
};
