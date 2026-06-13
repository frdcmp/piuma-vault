import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createCronJob,
	deleteCronJob,
	listCronJobs,
	runCronJobNow,
	toggleCronJob,
	updateCronJob,
} from "../api/cronApi";

export const cronKeys = {
	all: ["cron"],
	jobs: ["cron", "jobs"],
};

export const useCronJobs = (options = {}) =>
	useQuery({ queryKey: cronKeys.jobs, queryFn: listCronJobs, ...options });

const invalidate = (qc) => qc.invalidateQueries({ queryKey: cronKeys.jobs });

export const useCreateCronJob = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createCronJob,
		onSuccess: () => invalidate(qc),
	});
};

export const useUpdateCronJob = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateCronJob,
		onSuccess: () => invalidate(qc),
	});
};

export const useDeleteCronJob = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteCronJob,
		onSuccess: () => invalidate(qc),
	});
};

export const useRunCronJobNow = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: runCronJobNow,
		onSuccess: () => invalidate(qc),
	});
};

export const useToggleCronJob = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: toggleCronJob,
		onSuccess: () => invalidate(qc),
	});
};
