import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createCronJob,
	deleteCronJob,
	getCronJob,
	listCronJobs,
	listCronRuns,
	runCronJobNow,
	toggleCronJob,
	updateCronJob,
} from "../api/cron";

export const cronKeys = {
	all: ["cron"],
	jobs: () => ["cron", "jobs"],
	job: (id) => ["cron", "jobs", id],
	runs: (id) => ["cron", "jobs", id, "runs"],
};

export const useCronJobs = () =>
	useQuery({ queryKey: cronKeys.jobs(), queryFn: listCronJobs });

export const useCronJob = (id) =>
	useQuery({
		queryKey: cronKeys.job(id),
		queryFn: () => getCronJob(id),
		enabled: !!id,
	});

export const useCronRuns = (id) =>
	useQuery({
		queryKey: cronKeys.runs(id),
		queryFn: () => listCronRuns(id),
		enabled: !!id,
	});

const invalidateJobs = (qc) =>
	qc.invalidateQueries({ queryKey: cronKeys.jobs() });

export const useCreateCronJob = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createCronJob,
		onSuccess: () => invalidateJobs(qc),
	});
};

export const useUpdateCronJob = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateCronJob,
		onSuccess: (_d, vars) => {
			invalidateJobs(qc);
			if (vars?.id) qc.invalidateQueries({ queryKey: cronKeys.job(vars.id) });
		},
	});
};

export const useDeleteCronJob = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteCronJob,
		onSuccess: () => invalidateJobs(qc),
	});
};

export const useRunCronJobNow = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: runCronJobNow,
		onSuccess: (_d, id) => {
			invalidateJobs(qc);
			if (id) qc.invalidateQueries({ queryKey: cronKeys.runs(id) });
		},
	});
};

export const useToggleCronJob = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: toggleCronJob,
		onSuccess: () => invalidateJobs(qc),
	});
};
