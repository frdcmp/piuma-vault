import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import {
	bulkDelete,
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

// Storage has no SSE stream, so a file added elsewhere (web, API client) won't
// push here. Force a refresh of the whole storage family whenever the app
// returns to the foreground, so returning to the screen reflects changes made
// while away — regardless of staleTime. Mount once near the storage screen.
export const useStorageForegroundRefresh = () => {
	const qc = useQueryClient();
	useEffect(() => {
		const sub = AppState.addEventListener("change", (status) => {
			if (status === "active") {
				qc.invalidateQueries({ queryKey: storageKeys.all });
			}
		});
		return () => sub.remove();
	}, [qc]);
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

export const useStorageBulkDelete = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: bulkDelete,
		onSuccess: () => qc.invalidateQueries({ queryKey: storageKeys.all }),
	});
};

export const useStorageSignedUrl = () => useMutation({ mutationFn: signedUrl });

// Zips a folder server-side and returns a signed CDN URL to download it.
export const useStorageZip = () => useMutation({ mutationFn: zipBundle });
