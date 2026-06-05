import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createBucket,
	createTag,
	deleteBucket,
	deleteTag,
	fetchBuckets,
	fetchTags,
	fetchTagTree,
	updateBucket,
	updateTag,
} from "../api/tagsApi";
import { calendarKeys } from "./calendarQuery";
import { useResourceLiveUpdates } from "./liveUpdates";
import { taskKeys } from "./tasksQuery";

export const tagKeys = {
	all: ["tags"],
	buckets: () => ["tags", "buckets"],
	list: () => ["tags", "list"],
	tree: (scope) => ["tags", "tree", scope ?? null],
};

// A bucket/tag change can rewrite task/event tag arrays and shift counts, so
// refresh all three families.
const invalidateAll = (qc) => {
	qc.invalidateQueries({ queryKey: tagKeys.all });
	qc.invalidateQueries({ queryKey: taskKeys.all });
	qc.invalidateQueries({ queryKey: calendarKeys.all });
};

// ── Queries ───────────────────────────────────────────────────────────────────

export const useBuckets = (options = {}) =>
	useQuery({
		queryKey: tagKeys.buckets(),
		queryFn: fetchBuckets,
		staleTime: 60_000,
		...options,
	});

export const useTagRegistry = (options = {}) =>
	useQuery({
		queryKey: tagKeys.list(),
		queryFn: fetchTags,
		staleTime: 60_000,
		...options,
	});

export const useTagTree = (scope, options = {}) =>
	useQuery({
		queryKey: tagKeys.tree(scope),
		queryFn: () => fetchTagTree(scope),
		keepPreviousData: true,
		staleTime: 15_000,
		...options,
	});

// ── Mutations ─────────────────────────────────────────────────────────────────

export const useCreateBucket = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createBucket,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useUpdateBucket = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateBucket,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useDeleteBucket = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteBucket,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useCreateTag = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createTag,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useUpdateTag = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateTag,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useDeleteTag = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteTag,
		onSuccess: () => invalidateAll(qc),
	});
};

// ── Live updates (SSE) ──────────────────────────────────────────────────────
//
// Counts come from tasks/events, so a change on the relevant surface should
// refresh the tree. Reuses the per-surface streams.
export const useTagsLiveUpdates = (scope) => {
	const qc = useQueryClient();
	useResourceLiveUpdates({
		path:
			scope === "calendar" ? "/admin/calendar/stream" : "/admin/tasks/events",
		event: scope === "calendar" ? "event" : "task",
		queryClient: qc,
		queryKey: tagKeys.all,
	});
};
