import {
	FileSystemUploadType,
	uploadAsync,
} from "expo-file-system/legacy";
import { sanitizeKeyName } from "../utils/attachments";
import axiosInstance from "./axiosInstance";

// Bunny S3-compatible storage. Mirrors the web app's storage API, adapted for
// React Native (multipart uploads take a {uri,name,mimeType} file descriptor
// from expo-document-picker rather than a browser File/Blob).

// List objects + folders under a prefix (`""` for root). The backend collapses
// keys by `/` so we get separate `folders` and `files` arrays.
export const listObjects = async ({
	prefix = "",
	delimiter = "/",
	continuationToken,
	maxKeys,
} = {}) => {
	const params = { delimiter };
	if (prefix) params.prefix = prefix;
	if (continuationToken) params.continuation_token = continuationToken;
	if (maxKeys) params.max_keys = maxKeys;
	const { data } = await axiosInstance.get("/storage/list", { params });
	// Defensive: Bunny returns folders as zero-byte objects (no trailing slash),
	// so they can appear both as a folder and as a phantom file. Drop any file
	// whose key matches a folder. (The backend also filters these.)
	if (Array.isArray(data?.files) && Array.isArray(data?.folders)) {
		const folderKeys = new Set(data.folders);
		data.files = data.files.filter((f) => !folderKeys.has(`${f.key}/`));
	}
	return data;
};

// Direct upload: ask the backend for a presigned PUT URL, then stream the file
// STRAIGHT to Bunny from its local uri (expo-file-system). The bytes never pass
// through our backend — only the signed URL crosses the client↔backend boundary.
// `path` is the folder prefix (e.g. "docs/" or ""); `file` is a picker asset.
export const uploadFile = async ({ file, path = "" }) => {
	const key = `${path}${file.name || "upload"}`;
	const contentType = file.mimeType || "application/octet-stream";
	const { data } = await axiosInstance.post("/storage/presign-upload", {
		key,
		content_type: contentType,
	});
	const res = await uploadAsync(data.url, file.uri, {
		httpMethod: "PUT",
		uploadType: FileSystemUploadType.BINARY_CONTENT,
		headers: { "Content-Type": contentType },
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Direct upload to storage failed (HTTP ${res.status})`);
	}
	return { key: data.key, publicUrl: data.public_url };
};

// Upload a note attachment to the public `notes-attachments/<noteId>/` prefix
// and return its tokenless public CDN URL (`publicUrl`) plus the ORIGINAL
// filename (used as the markdown label). The stored key is sanitized to a
// URL-safe name so the CDN URL never needs escaping. The caller embeds it via
// `attachmentMarkdown`.
export const uploadAttachment = async ({ file, noteId }) => {
	const original = file.name || "upload";
	const safeName = sanitizeKeyName(original);
	const path = `notes-attachments/${noteId || "misc"}/`;
	const { key, publicUrl } = await uploadFile({
		file: { ...file, name: safeName },
		path,
	});
	return { key, publicUrl, filename: original };
};

// Zip a folder server-side (staged to __temp on Bunny); returns `{ url, key }` —
// a signed CDN URL the client opens/downloads directly.
export const zipBundle = async ({ keys = [], prefix, filename } = {}) => {
	const body = { keys };
	if (prefix) body.prefix = prefix;
	if (filename) body.filename = filename;
	const { data } = await axiosInstance.post("/storage/zip", body);
	return data;
};

export const deleteObject = async (key) => {
	const { data } = await axiosInstance.delete(
		`/storage/object/${encodeURI(key)}`,
	);
	return data;
};

// Recursive delete of every key under a folder prefix.
export const deleteFolder = async (path) => {
	const { data } = await axiosInstance.delete("/storage/folder", {
		data: { path },
	});
	return data;
};

// Issue a Bunny URL-Token-Auth signed CDN URL for a single object so it can be
// opened/shared from the device. `expiresInSecs` defaults to 1 hour.
export const signedUrl = async ({ key, expiresInSecs = 3600 }) => {
	const { data } = await axiosInstance.post("/storage/signed-url", {
		key,
		expires_in_secs: expiresInSecs,
	});
	return data;
};
