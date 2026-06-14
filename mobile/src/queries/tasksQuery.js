import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
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
} from "../api/tasksApi";
import { useResourceLiveUpdates } from "./liveUpdates";

export const taskKeys = {
	all: ["tasks"],
	list: (filter) => ["tasks", "list", filter ?? {}],
	done: (filter) => ["tasks", "done", filter ?? {}],
	detail: (id) => ["tasks", "detail", id],
	recurring: () => ["tasks", "recurring"],
};

// Completed tasks are paged from the server rather than loaded all at once — a
// long history would otherwise bloat every list fetch and render.
export const DONE_PAGE_SIZE = 20;

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

// Single task by id — the deep-link fallback so a chat link opens the task even
// when it isn't in the loaded to-do page (e.g. a completed task).
export const useTask = (id, options = {}) =>
	useQuery({
		queryKey: taskKeys.detail(id),
		queryFn: () => fetchTask(id),
		enabled: !!id,
		...options,
	});

// Completed-task history, paged. `filter` carries the active bucket/tag scope
// (bucket / no_bucket / tag); `recurring: false` keeps it to one-off tasks, to
// match the to-do list. The query key sits under ["tasks", …] so task mutations
// and the live-update stream invalidate it like every other tasks query.
export const useDoneTasks = (filter = {}, options = {}) =>
	useInfiniteQuery({
		queryKey: taskKeys.done(filter),
		queryFn: ({ pageParam = 0 }) =>
			fetchTasks({
				...filter,
				done: true,
				recurring: false,
				limit: DONE_PAGE_SIZE,
				offset: pageParam,
			}),
		initialPageParam: 0,
		// A short page (fewer rows than asked) means the end of the history.
		getNextPageParam: (lastPage, allPages) =>
			lastPage.length < DONE_PAGE_SIZE
				? undefined
				: allPages.length * DONE_PAGE_SIZE,
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
