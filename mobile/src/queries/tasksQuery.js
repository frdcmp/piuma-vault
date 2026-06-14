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
import { markLocalChange, useResourceLiveUpdates } from "./liveUpdates";

// SSE channel task mutations broadcast on. Marked at request start so the echo
// of a local change is suppressed (see liveUpdates `markLocalChange`).
const TASKS_SSE_PATH = "/admin/tasks/events";

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

// ── Surgical cache reconciliation ─────────────────────────────────────────────
//
// A task change touches a small, knowable set of caches: the to-do list (one
// array, filtered client-side), the paged completed history, and the detail
// entry. Rather than refetch the whole family on every change, patch those
// caches in place from a fresh task row. Used by both local mutations (the row
// the API returns) and remote SSE events (a single fetched row).

// Server order for a to-do (non-done) listing: `rank ASC NULLS LAST, created_at
// ASC` — mirrors `list_tasks` so an inserted row lands where the server would.
// `rank` is a COLLATE "C" fractional-index key, so a plain string compare
// matches the DB's byte ordering.
const byTodoOrder = (a, b) => {
	if (a.done !== b.done) return a.done ? 1 : -1; // pending before done
	if (a.rank !== b.rank) {
		if (a.rank == null) return 1; // NULLS LAST
		if (b.rank == null) return -1;
		return a.rank < b.rank ? -1 : 1;
	}
	return new Date(a.created_at) - new Date(b.created_at);
};

// Completion history order: most-recently-finished first.
const byDoneOrder = (a, b) =>
	new Date(b.completed_at ?? b.created_at) -
	new Date(a.completed_at ?? a.created_at);

// Does `task` belong in a list cache keyed by `filter`? Mirrors the server's
// WHERE clauses (done / recurring / bucket / no_bucket / tag).
const matchesListFilter = (task, filter = {}) => {
	if (filter.done !== undefined && task.done !== filter.done) return false;
	if (filter.recurring === false && task.recurrence_id) return false;
	if (filter.recurring === true && !task.recurrence_id) return false;
	if (filter.bucket !== undefined && task.bucket_id !== filter.bucket)
		return false;
	if (filter.no_bucket && task.bucket_id) return false;
	if (filter.tag && !(task.tags ?? []).includes(filter.tag)) return false;
	return true;
};

// Patch a fresh task row into every cached list + its detail entry. No network.
export const upsertTaskIntoCaches = (qc, task) => {
	if (!task?.id) return;
	qc.setQueryData(taskKeys.detail(task.id), task);

	// Non-paged list arrays (e.g. the to-do list ["tasks","list",{done:false}]).
	for (const q of qc.getQueryCache().findAll({ queryKey: ["tasks", "list"] })) {
		const filter = q.queryKey[2] ?? {};
		qc.setQueryData(q.queryKey, (old) => {
			if (!Array.isArray(old)) return old;
			const without = old.filter((t) => t.id !== task.id);
			if (!matchesListFilter(task, filter)) return without; // moved out
			const next = [...without, task];
			next.sort(filter.done === true ? byDoneOrder : byTodoOrder);
			return next;
		});
	}

	// Paged completed history (["tasks","done",filter] infinite queries). A done
	// cache implies done:true + recurring:false on top of its bucket/tag filter.
	for (const q of qc.getQueryCache().findAll({ queryKey: ["tasks", "done"] })) {
		const data = qc.getQueryData(q.queryKey);
		if (!data?.pages) continue;
		const filter = q.queryKey[2] ?? {};
		const belongs =
			task.done &&
			!task.recurrence_id &&
			matchesListFilter(task, { ...filter, done: true });
		const present = data.pages.some((p) => p.some((t) => t.id === task.id));
		if (present) {
			qc.setQueryData(q.queryKey, (old) => ({
				...old,
				pages: old.pages.map((p) =>
					p.flatMap((t) => (t.id !== task.id ? [t] : belongs ? [task] : [])),
				),
			}));
		} else if (belongs) {
			// Newly completed (or now matches the filter): can't slot it into the
			// right page/offset, so refetch just this active done query.
			qc.invalidateQueries({ queryKey: q.queryKey });
		}
	}
};

// Drop a task id from every cached list + its detail entry. No network.
export const removeTaskFromCaches = (qc, id) => {
	qc.removeQueries({ queryKey: taskKeys.detail(id) });
	for (const q of qc.getQueryCache().findAll({ queryKey: ["tasks", "list"] })) {
		qc.setQueryData(q.queryKey, (old) =>
			Array.isArray(old) ? old.filter((t) => t.id !== id) : old,
		);
	}
	for (const q of qc.getQueryCache().findAll({ queryKey: ["tasks", "done"] })) {
		qc.setQueryData(q.queryKey, (old) =>
			old?.pages
				? { ...old, pages: old.pages.map((p) => p.filter((t) => t.id !== id)) }
				: old,
		);
	}
};

// Apply a remote {action,id} task event surgically. Deletes patch caches with
// no network; create/update fetch the single row and upsert it. An id that
// isn't a concrete task (a recurring template emits "task" events under its own
// id) 404s → fall back to a blunt family refresh.
export const applyTaskEvent = async (qc, action, id) => {
	if (action === "deleted") {
		removeTaskFromCaches(qc, id);
		return;
	}
	try {
		const task = await fetchTask(id);
		if (task?.id) {
			upsertTaskIntoCaches(qc, task);
			return;
		}
	} catch {
		/* 404 → not a concrete task (likely a recurring template) */
	}
	invalidateAll(qc);
};

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
		onMutate: () => markLocalChange(TASKS_SSE_PATH),
		onSuccess: (task) => upsertTaskIntoCaches(qc, task),
	});
};

export const useUpdateTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateTask,
		onMutate: () => markLocalChange(TASKS_SSE_PATH),
		onSuccess: (task) => upsertTaskIntoCaches(qc, task),
	});
};

export const useToggleTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: toggleTask,
		onMutate: () => markLocalChange(TASKS_SSE_PATH),
		onSuccess: (task) => upsertTaskIntoCaches(qc, task),
	});
};

export const useDeleteTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteTask,
		onMutate: () => markLocalChange(TASKS_SSE_PATH),
		onSuccess: (_data, id) => removeTaskFromCaches(qc, id),
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
		onMutate: () => markLocalChange(TASKS_SSE_PATH),
		onSuccess: () => invalidateAll(qc),
	});
};

export const useUpdateRecurringTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateRecurringTask,
		onMutate: () => markLocalChange(TASKS_SSE_PATH),
		onSuccess: () => invalidateAll(qc),
	});
};

export const useDeleteRecurringTask = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteRecurringTask,
		onMutate: () => markLocalChange(TASKS_SSE_PATH),
		onSuccess: () => invalidateAll(qc),
	});
};

export const useCompleteOccurrence = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: completeOccurrence,
		onMutate: () => markLocalChange(TASKS_SSE_PATH),
		onSuccess: () => invalidateAll(qc),
	});
};

// ── Live updates (SSE) ──────────────────────────────────────────────────────
//
// Subscribes to the backend task event stream so this device reflects changes
// made elsewhere (web, another phone, API-key clients). Events are applied
// surgically (`applyTaskEvent`): a delete patches caches with no network, a
// create/update fetches just that row. `queryKey` is the blunt fallback the
// generic hook invalidates on a reconnect gap (when individual events can't be
// replayed). Mount once near the tasks screen root.
export const useTasksLiveUpdates = () => {
	const qc = useQueryClient();
	useResourceLiveUpdates({
		path: "/admin/tasks/events",
		event: "task",
		queryClient: qc,
		queryKey: taskKeys.all,
		onEvent: applyTaskEvent,
	});
};
