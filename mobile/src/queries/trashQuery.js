import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	emptyTrash,
	fetchTrash,
	permanentlyDeleteNote,
	restoreNote,
} from "../api/notesApi";

export const trashKeys = {
	all: ["trash"],
	list: (params) => ["trash", "list", params],
};

// Soft-deleted notes. Lives under its own key so it doesn't collide with the
// active notes list/browse caches.
export const useTrash = (params = {}, options = {}) =>
	useQuery({
		queryKey: trashKeys.list(params),
		queryFn: () => fetchTrash(params),
		staleTime: 30_000,
		...options,
	});

// Restore puts the note back in its folder — refresh trash and the notes tree.
export const useRestoreNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: restoreNote,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: trashKeys.all });
			qc.invalidateQueries({ queryKey: ["notes"] });
		},
	});
};

// Permanent delete — purges content + attachments. Only the trash list changes.
export const usePermanentlyDeleteNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: permanentlyDeleteNote,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: trashKeys.all });
		},
	});
};

export const useEmptyTrash = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: emptyTrash,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: trashKeys.all });
		},
	});
};
