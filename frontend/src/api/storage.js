import { sanitizeKeyName } from "../utils/attachments";
import axiosInstance from "./axiosInstance";

// Mobile app update manifest published by `mobile/build.sh` to storage:
// { version, buildTime, apkKey, apkFilename, notes }. 404 until a build runs.
export const getAppUpdateManifest = async () => {
	const { data } = await axiosInstance.get("/storage/app-update-manifest");
	return data;
};

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

// Direct upload: ask the backend for a short-lived presigned PUT URL, then send
// the file bytes STRAIGHT to Bunny. The file never passes through our backend —
// only the signed URL crosses the client↔backend boundary. `path` is the folder
// prefix (e.g. "docs/" or ""); the file lands at `<path><file.name>`.
// `onProgress(fraction)` (0..1) fires as bytes are sent. We use XHR rather than
// fetch for the PUT because fetch has no upload-progress events.
export const uploadFile = async ({ file, path = "", onProgress }) => {
	const key = `${path}${file.name}`;
	const contentType = file.type || "application/octet-stream";
	const { data } = await axiosInstance.post("/storage/presign-upload", {
		key,
		content_type: contentType,
	});
	await putWithProgress(data.url, file, contentType, onProgress);
	return { key: data.key, publicUrl: data.public_url };
};

// Direct PUT to Bunny with upload-progress callbacks.
const putWithProgress = (url, file, contentType, onProgress) =>
	new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		xhr.setRequestHeader("Content-Type", contentType);
		if (typeof onProgress === "function") {
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) onProgress(e.loaded / e.total);
			};
		}
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				onProgress?.(1);
				resolve();
			} else {
				reject(
					new Error(`Direct upload to storage failed (HTTP ${xhr.status})`),
				);
			}
		};
		xhr.onerror = () =>
			reject(new Error("Direct upload to storage failed (network error)"));
		xhr.send(file);
	});

// Upload a note attachment to the public `notes-attachments/<noteId>/` prefix
// and return its tokenless public CDN URL (`publicUrl`) plus the ORIGINAL
// filename (used as the markdown label). The stored key is sanitized to a
// URL-safe name so the CDN URL never needs escaping. The caller embeds it via
// `attachmentMarkdown`.
export const uploadAttachment = async ({ file, noteId }) => {
	const original = file.name || "upload";
	const safeName = sanitizeKeyName(original);
	const path = `notes-attachments/${noteId || "misc"}/`;
	const renamed =
		safeName === file.name
			? file
			: new File([file], safeName, { type: file.type });
	const { key, publicUrl } = await uploadFile({ file: renamed, path });
	return { key, publicUrl, filename: original };
};

// Upload a pasted/attached chat image to the disposable `__temp/chat/<convId>/`
// prefix and return its tokenless public CDN URL (sent to the vision model) plus
// the S3 `key` (kept so it can be cleaned up with its conversation). Treated as a
// temp file — see the recorder cleanup pattern + the orphan sweep policy.
// NOTE: the `__temp/` prefix must be served publicly (token-excluded on the pull
// zone) so the LLM provider can fetch the image by URL.
export const uploadChatImage = async ({ file, conversationId, onProgress }) => {
	const ext = file.type?.split("/")[1] || "png";
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const safe = sanitizeKeyName(file.name || `image.${ext}`);
	const named = new File([file], `${stamp}-${safe}`, {
		type: file.type || "image/png",
	});
	const path = `__temp/chat/${conversationId || "misc"}/`;
	const { key, publicUrl } = await uploadFile({
		file: named,
		path,
		onProgress,
	});
	return { key, publicUrl, media_type: file.type || "image/png" };
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

export const bulkDelete = async (keys) => {
	const { data } = await axiosInstance.post("/storage/bulk/delete", { keys });
	return data;
};

export const bulkMove = async (items) => {
	const { data } = await axiosInstance.post("/storage/bulk/move", { items });
	return data;
};

// Issue a Bunny URL-Token-Auth signed CDN URL for a single object.
// `expiresInSecs` defaults to 3600 (1 hour).
export const signedUrl = async ({ key, expiresInSecs = 3600 }) => {
	const { data } = await axiosInstance.post("/storage/signed-url", {
		key,
		expires_in_secs: expiresInSecs,
	});
	return data;
};

// Build a zip of everything under `prefix` (and/or explicit `keys`) server-side,
// staged to the internal `__temp/` folder on Bunny. Returns `{ url, key }` — a
// signed CDN URL the client downloads directly. No archive bytes pass through us.
export const zipBundle = async ({
	keys = [],
	prefix,
	prefixes = [],
	filename,
} = {}) => {
	const body = { keys };
	if (prefix) body.prefix = prefix;
	if (prefixes.length) body.prefixes = prefixes;
	if (filename) body.filename = filename;
	const { data } = await axiosInstance.post("/storage/zip", body);
	return data;
};
