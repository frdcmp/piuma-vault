import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createBucket,
	createTag,
	deleteBucket,
	deleteTag,
	fetchBuckets,
	fetchTags,
	updateBucket,
	updateTag,
} from "../api/tags";
import { calendarKeys } from "./calendarQuery";
import { useResourceLiveUpdates } from "./liveUpdates";
import { taskKeys } from "./tasksQuery";

export const tagKeys = {
	all: ["tags"],
	buckets: () => ["tags", "buckets"],
	list: () => ["tags", "list"],
};

// Buckets/tags are shared by tasks + calendar. A bucket/tag change can rewrite
// task/event tag arrays and shift usage counts, so refresh all three families.
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

// Named useTagRegistry (not useTags) to avoid clashing with notesQuery's useTags
// in the queries barrel.
export const useTagRegistry = (options = {}) =>
	useQuery({
		queryKey: tagKeys.list(),
		queryFn: fetchTags,
		staleTime: 60_000,
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
// The tree's counts come from tasks/events, so a change on the relevant surface
// should refresh the tree. Reuses the existing per-surface streams; mount once
// near each tags filter (scope "tasks" → tasks stream, "calendar" → calendar).
export const useTagsLiveUpdates = (scope) =>
	useResourceLiveUpdates({
		path:
			scope === "calendar" ? "/admin/calendar/stream" : "/admin/tasks/events",
		event: scope === "calendar" ? "event" : "task",
		queryKey: tagKeys.all,
	});
