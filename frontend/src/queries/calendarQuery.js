import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createEvent,
	deleteEvent,
	fetchEvent,
	fetchEvents,
	updateEvent,
} from "../api/calendar";
import { markLocalChange, useResourceLiveUpdates } from "./liveUpdates";

// SSE channel calendar mutations broadcast on. Marked at request start so the
// echo of a local change is suppressed (see liveUpdates `markLocalChange`).
const CALENDAR_SSE_PATH = "/admin/calendar/stream";

export const calendarKeys = {
	all: ["calendar"],
	range: (from, to, tag) => ["calendar", "range", from, to, tag ?? null],
	detail: (id) => ["calendar", "detail", id],
};

// ── Surgical cache reconciliation ─────────────────────────────────────────────
//
// Calendar queries are keyed by visible range (from, to, tag) and hold a flat,
// starts_at-ordered array of events (the client expands recurring *tasks*, not
// event rrules, so each event is a single row). Rather than refetch every loaded
// range on a change, patch the affected ranges in place from a fresh event row.
const byStartsAt = (a, b) => new Date(a.starts_at) - new Date(b.starts_at);

// Does `event` fall in a range cache keyed by (from, to, tag)? Mirrors the
// server's overlap test: starts before the window ends, ends at/after it begins.
const eventInRange = (event, from, to, tag) => {
	if (tag && !(event.tags ?? []).includes(tag)) return false;
	const s = new Date(event.starts_at).getTime();
	const e = new Date(event.ends_at ?? event.starts_at).getTime();
	return s < new Date(to).getTime() && e >= new Date(from).getTime();
};

// Patch a fresh event row into every loaded range cache + its detail entry.
export const upsertEventIntoCaches = (qc, event) => {
	if (!event?.id) return;
	qc.setQueryData(calendarKeys.detail(event.id), event);
	for (const q of qc
		.getQueryCache()
		.findAll({ queryKey: ["calendar", "range"] })) {
		const [, , from, to, tag] = q.queryKey;
		qc.setQueryData(q.queryKey, (old) => {
			if (!Array.isArray(old)) return old;
			const without = old.filter((e) => e.id !== event.id);
			if (!eventInRange(event, from, to, tag)) return without; // moved out
			return [...without, event].sort(byStartsAt);
		});
	}
};

// Drop an event id from every loaded range cache + its detail entry.
export const removeEventFromCaches = (qc, id) => {
	qc.removeQueries({ queryKey: calendarKeys.detail(id) });
	for (const q of qc
		.getQueryCache()
		.findAll({ queryKey: ["calendar", "range"] })) {
		qc.setQueryData(q.queryKey, (old) =>
			Array.isArray(old) ? old.filter((e) => e.id !== id) : old,
		);
	}
};

// Apply a remote {action,id} calendar event surgically; create/update fetch the
// single row and upsert it, delete patches caches with no network.
export const applyCalendarEvent = async (qc, action, id) => {
	if (action === "deleted") {
		removeEventFromCaches(qc, id);
		return;
	}
	try {
		const event = await fetchEvent(id);
		if (event?.id) {
			upsertEventIntoCaches(qc, event);
			return;
		}
	} catch {
		/* fall through to a blunt refresh */
	}
	qc.invalidateQueries({ queryKey: calendarKeys.all });
};

// ── List (visible range) ────────────────────────────────────────────────────

export const useCalendarEvents = ({ from, to, tag } = {}, options = {}) =>
	useQuery({
		queryKey: calendarKeys.range(from, to, tag),
		queryFn: () => fetchEvents({ from, to, tag }),
		enabled: !!from && !!to,
		keepPreviousData: true,
		staleTime: 30_000,
		...options,
	});

export const useCalendarEvent = (id) =>
	useQuery({
		queryKey: calendarKeys.detail(id),
		queryFn: () => fetchEvent(id),
		enabled: !!id,
	});

// ── Mutations ─────────────────────────────────────────────────────────────────

export const useCreateEvent = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createEvent,
		onMutate: () => markLocalChange(CALENDAR_SSE_PATH),
		onSuccess: (event) => upsertEventIntoCaches(qc, event),
	});
};

export const useUpdateEvent = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateEvent,
		onMutate: () => markLocalChange(CALENDAR_SSE_PATH),
		onSuccess: (event) => upsertEventIntoCaches(qc, event),
	});
};

export const useDeleteEvent = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteEvent,
		onMutate: () => markLocalChange(CALENDAR_SSE_PATH),
		onSuccess: (_data, id) => removeEventFromCaches(qc, id),
	});
};

// ── Live updates (SSE) ──────────────────────────────────────────────────────
//
// Subscribes to the backend calendar event stream so this tab reflects changes
// made elsewhere. Events are applied surgically (`applyCalendarEvent`): a delete
// patches the loaded ranges with no network, a create/update fetches just that
// row. `queryKey` is the blunt fallback on a reconnect gap. Mount once near the
// calendar view root.
export const useCalendarLiveUpdates = () =>
	useResourceLiveUpdates({
		path: "/admin/calendar/stream",
		event: "event",
		queryKey: calendarKeys.all,
		onEvent: applyCalendarEvent,
	});
