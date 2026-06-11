import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createRecording,
	deleteRecording,
	getRecording,
	getRecordingTranscript,
	listRecordings,
	renameRecording,
	stopRecording,
} from "../api/recorder";

const RECORDINGS_KEY = ["recordings"];

export const useRecordings = () =>
	useQuery({
		queryKey: RECORDINGS_KEY,
		queryFn: listRecordings,
	});

export const useRecording = (id) =>
	useQuery({
		queryKey: [...RECORDINGS_KEY, id],
		queryFn: () => getRecording(id),
		enabled: !!id,
	});

export const useRecordingTranscript = (id) =>
	useQuery({
		queryKey: [...RECORDINGS_KEY, id, "transcript"],
		queryFn: () => getRecordingTranscript(id),
		enabled: !!id,
	});

export const useCreateRecording = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createRecording,
		onSuccess: () => qc.invalidateQueries({ queryKey: RECORDINGS_KEY }),
	});
};

export const useStopRecording = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: stopRecording,
		onSuccess: () => qc.invalidateQueries({ queryKey: RECORDINGS_KEY }),
	});
};

export const useRenameRecording = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: renameRecording,
		onSuccess: () => qc.invalidateQueries({ queryKey: RECORDINGS_KEY }),
	});
};

export const useDeleteRecording = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteRecording,
		onSuccess: () => qc.invalidateQueries({ queryKey: RECORDINGS_KEY }),
	});
};
