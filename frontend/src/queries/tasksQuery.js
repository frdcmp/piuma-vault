import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	completeOccurrence,
	createRecurringTask,
	createTask,
	deleteRecurringTask,
	deleteTask,
	fetchRecurringTasks,
	fetchTask,
	fetchTasks,
	toggleTask,
	updateRecurringTask,
	updateTask,
} from "../api/tasks";
import { useResourceLiveUpdates } from "./liveUpdates";

export const taskKeys = {
	all: ["tasks"],
	list: (filter) => ["tasks", "list", filter ?? {}],
	recurring: () => ["tasks", "recurring"],
	detail: (id) => ["tasks", "detail", id],
};

// Invalidate everything tasks-related: concrete tasks and recurring templates
// (a completed occurrence materializes a task, and a template edit changes
// expansion), so both families refresh together.
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

// Single task by id — used for deep-linking (?task=<id>) when the task isn't in
// the loaded list.
export const useTask = (id) =>
	useQuery({
		queryKey: taskKeys.detail(id),
		queryFn: () => fetchTask(id),
		enabled: !!id,
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
// Subscribes to the backend task event stream so this tab reflects changes made
// elsewhere (another tab, the mobile app, API-key clients). Any event refetches
// the whole tasks family (lists are keyed by filter, so per-id targeting
// wouldn't help). Mount once near the tasks view root.
export const useTasksLiveUpdates = () =>
	useResourceLiveUpdates({
		path: "/admin/tasks/events",
		event: "task",
		queryKey: taskKeys.all,
	});
