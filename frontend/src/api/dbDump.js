import axiosInstance from "./axiosInstance";

/** List DB backups stored under the S3 `dump/` folder (newest first). */
export const listDumps = async () => {
	const response = await axiosInstance.get("/admin/db-dump/list");
	return response.data;
};

/** Dump the whole database and upload it to the S3 `dump/` folder. */
export const createDump = async () => {
	const response = await axiosInstance.post("/admin/db-dump/create");
	return response.data;
};

/** Get a time-limited URL to download a backup file. */
export const downloadDump = async (key) => {
	const response = await axiosInstance.post("/admin/db-dump/download", { key });
	return response.data;
};

/** Delete a backup file from the `dump/` folder. */
export const deleteDump = async (key) => {
	const response = await axiosInstance.post("/admin/db-dump/delete", { key });
	return response.data;
};

/** DESTRUCTIVE: wipe the database and restore it from the given backup. */
export const restoreDump = async (key) => {
	const response = await axiosInstance.post("/admin/db-dump/restore", { key });
	return response.data;
};
