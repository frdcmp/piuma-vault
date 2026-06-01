import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createDump,
	deleteDump,
	downloadDump,
	listDumps,
	restoreDump,
} from "../api/dbDump";

export const dbDumpKeys = {
	all: ["db-dump"],
	list: () => ["db-dump", "list"],
};

export const useDumps = () =>
	useQuery({
		queryKey: dbDumpKeys.list(),
		queryFn: listDumps,
	});

export const useCreateDump = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createDump,
		onSuccess: () => qc.invalidateQueries({ queryKey: dbDumpKeys.list() }),
	});
};

export const useDeleteDump = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteDump,
		onSuccess: () => qc.invalidateQueries({ queryKey: dbDumpKeys.list() }),
	});
};

export const useDownloadDump = () => useMutation({ mutationFn: downloadDump });

export const useRestoreDump = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: restoreDump,
		onSuccess: () => qc.invalidateQueries({ queryKey: dbDumpKeys.list() }),
	});
};
