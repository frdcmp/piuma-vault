import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	bulkDelete,
	bulkMove,
	deleteFolder,
	deleteObject,
	listObjects,
	signedUrl,
	uploadAttachment,
	uploadFile,
	zipBundle,
} from "../api/storage";

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

// Uploads a note attachment to the public `notes-attachments/` prefix. Returns
// `{ key, publicUrl, filename }`; the caller embeds `publicUrl` in the note.
export const useUploadAttachment = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: uploadAttachment,
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

export const useStorageBulkMove = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: bulkMove,
		onSuccess: () => qc.invalidateQueries({ queryKey: storageKeys.all }),
	});
};

// Signs a short-lived CDN URL and lets the browser fetch the bytes DIRECTLY
// from Bunny — the file never passes through our backend. Only the signed URL
// crosses the frontend↔backend boundary.
export const useStorageDownload = () =>
	useMutation({
		mutationFn: async (key) => {
			const { url } = await signedUrl({ key, expiresInSecs: 300 });
			const a = document.createElement("a");
			a.href = url;
			a.download = key.split("/").pop() || "download";
			a.rel = "noopener";
			document.body.appendChild(a);
			a.click();
			a.remove();
		},
	});

// Requests a signed (token-auth) CDN URL with an expiry.
export const useStorageSignedUrl = () => useMutation({ mutationFn: signedUrl });

// Zips a folder server-side (staged to __temp on Bunny) and downloads the
// archive DIRECTLY from the CDN — the zip bytes never pass through our backend.
export const useStorageZip = () =>
	useMutation({
		mutationFn: async ({ keys, prefix, filename }) => {
			const { url } = await zipBundle({ keys, prefix, filename });
			const a = document.createElement("a");
			a.href = url;
			a.download = `${filename || "bundle"}.zip`;
			a.rel = "noopener";
			document.body.appendChild(a);
			a.click();
			a.remove();
		},
	});
