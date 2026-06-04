import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	completeOccurrence,
	createRecurringTask,
	createTask,
	deleteRecurringTask,
	deleteTask,
	fetchRecurringTasks,
	fetchTasks,
	toggleTask,
	updateRecurringTask,
	updateTask,
} from "../api/tasksApi";
import { useResourceLiveUpdates } from "./liveUpdates";

export const taskKeys = {
	all: ["tasks"],
	list: (filter) => ["tasks", "list", filter ?? {}],
	recurring: () => ["tasks", "recurring"],
};

const invalidateAll = (qc) => qc.invalidateQueries({ queryKey: taskKeys.all });

// ── Tasks ───────────────────────────────────────────────────────────────────

export const useTasks = (filter = {}, options = {}) =>
	useQuery({
		queryKey: taskKeys.list(filter),
		queryFn: () => fetchTasks(filter),
		keepPreviousData: true,
		staleTime: 30_000,
		...options,
	});

export const useCreateTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createTask,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useUpdateTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateTask,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useToggleTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: toggleTask,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useDeleteTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteTask,
		onSuccess: () => invalidateAll(qc),
	});
};

// ── Recurring-task templates ──────────────────────────────────────────────────

export const useRecurringTasks = (options = {}) =>
	useQuery({
		queryKey: taskKeys.recurring(),
		queryFn: fetchRecurringTasks,
		staleTime: 60_000,
		...options,
	});

export const useCreateRecurringTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createRecurringTask,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useUpdateRecurringTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateRecurringTask,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useDeleteRecurringTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteRecurringTask,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useCompleteOccurrence = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: completeOccurrence,
		onSuccess: () => invalidateAll(qc),
	});
};

// ── Live updates (SSE) ──────────────────────────────────────────────────────
//
// Subscribes to the backend task event stream so this device reflects changes
// made elsewhere (web, another phone, API-key clients). Any event refetches the
// whole tasks family (lists are keyed by filter, so per-id targeting wouldn't
// help). Mount once near the tasks screen root.
export const useTasksLiveUpdates = () => {
	const qc = useQueryClient();
	useResourceLiveUpdates({
		path: "/admin/tasks/events",
		event: "task",
		queryClient: qc,
		queryKey: taskKeys.all,
	});
};
