import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	deleteFolder,
	deleteObject,
	listObjects,
	signedUrl,
	uploadFile,
	zipBundle,
} from "../api/storageApi";

export const storageKeys = {
	all: ["storage"],
	list: (params) => ["storage", "list", params],
};

export const useStorageList = (params = {}, options = {}) =>
	useQuery({
		queryKey: storageKeys.list(params),
		queryFn: () => listObjects(params),
		staleTime: 30_000,
		...options,
	});

export const useStorageUpload = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: uploadFile,
		onSuccess: () => qc.invalidateQueries({ queryKey: storageKeys.all }),
	});
};

export const useStorageDeleteObject = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteObject,
		onSuccess: () => qc.invalidateQueries({ queryKey: storageKeys.all }),
	});
};

export const useStorageDeleteFolder = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteFolder,
		onSuccess: () => qc.invalidateQueries({ queryKey: storageKeys.all }),
	});
};

export const useStorageSignedUrl = () => useMutation({ mutationFn: signedUrl });

// Zips a folder server-side and returns a signed CDN URL to download it.
export const useStorageZip = () => useMutation({ mutationFn: zipBundle });
