import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	deleteRecording,
	getRecorderUsage,
	getRecording,
	getRecordingTranscript,
	listRecordings,
	summariseRecording,
} from "../api/recorderApi";

export const recorderKeys = {
	all: ["recordings"],
	detail: (id) => ["recordings", id],
	transcript: (id) => ["recordings", id, "transcript"],
	usage: ["recordings", "usage"],
};

export const useRecordings = (options = {}) =>
	useQuery({
		queryKey: recorderKeys.all,
		queryFn: listRecordings,
		staleTime: 15_000,
		...options,
	});

export const useRecording = (id, options = {}) =>
	useQuery({
		queryKey: recorderKeys.detail(id),
		queryFn: () => getRecording(id),
		enabled: !!id,
		...options,
	});

export const useRecordingTranscript = (id, options = {}) =>
	useQuery({
		queryKey: recorderKeys.transcript(id),
		queryFn: () => getRecordingTranscript(id),
		enabled: !!id,
		...options,
	});

export const useRecorderUsage = (options = {}) =>
	useQuery({
		queryKey: recorderKeys.usage,
		queryFn: getRecorderUsage,
		staleTime: 60_000,
		...options,
	});

export const useSummariseRecording = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: summariseRecording,
		onSuccess: () => qc.invalidateQueries({ queryKey: recorderKeys.all }),
	});
};

export const useDeleteRecording = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteRecording,
		onSuccess: () => qc.invalidateQueries({ queryKey: recorderKeys.all }),
	});
};
