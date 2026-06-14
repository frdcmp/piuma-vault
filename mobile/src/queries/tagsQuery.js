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
} from "../api/tagsApi";
import { calendarKeys } from "./calendarQuery";
import { useResourceLiveUpdates } from "./liveUpdates";
import { taskKeys } from "./tasksQuery";

export const tagKeys = {
	all: ["tags"],
	buckets: () => ["tags", "buckets"],
	list: () => ["tags", "list"],
};

// Invalidation is scoped to what actually changed, since refetching every task
// and event on a colour tweak is wasteful:
//   - Buckets are referenced by tasks via `bucket_id` and resolved to a name +
//     colour client-side, so create/update only need the buckets list. Events
//     have no bucket, so calendar is never affected. A *delete* clears
//     `bucket_id` on tasks, so it also refreshes tasks.
//   - Tags are stored on tasks/events as *names*, so a rename or delete rewrites
//     those arrays → refresh tasks + calendar. A colour-only change resolves
//     client-side from the registry → registry alone.
const invalidateTags = (qc) => qc.invalidateQueries({ queryKey: tagKeys.all });
const invalidateTasksAndCalendar = (qc) => {
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

// ── Mutations ─────────────────────────────────────────────────────────────────

export const useCreateBucket = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createBucket,
		// A new bucket is referenced by no task yet — only the buckets list changes.
		onSuccess: () => invalidateTags(qc),
	});
};

export const useUpdateBucket = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateBucket,
		// Tasks resolve bucket name + colour by id at render, so a bucket edit only
		// needs the buckets list refreshed — not every task.
		onSuccess: () => invalidateTags(qc),
	});
};

export const useDeleteBucket = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteBucket,
		// Deleting a bucket clears `bucket_id` on its tasks → refresh tasks too.
		onSuccess: () => {
			invalidateTags(qc);
			qc.invalidateQueries({ queryKey: taskKeys.all });
		},
	});
};

export const useCreateTag = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createTag,
		// A new tag is on no task/event yet — only the registry changes.
		onSuccess: () => invalidateTags(qc),
	});
};

export const useUpdateTag = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateTag,
		onSuccess: (_data, vars) => {
			invalidateTags(qc);
			// A rename rewrites the tag-name arrays on tasks + events; a colour-only
			// change is resolved client-side from the registry. Only refetch
			// tasks/calendar when the name actually changed (or the old tag is
			// unknown, so we can't be sure).
			const old = (qc.getQueryData(tagKeys.list()) || []).find(
				(t) => t.id === vars.id,
			);
			if (vars.name !== undefined && (!old || vars.name !== old.name))
				invalidateTasksAndCalendar(qc);
		},
	});
};

export const useDeleteTag = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteTag,
		// Removing a tag strips it from every task/event's tag array.
		onSuccess: () => {
			invalidateTags(qc);
			invalidateTasksAndCalendar(qc);
		},
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
