import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createEvent,
	deleteEvent,
	fetchEvent,
	fetchEvents,
	updateEvent,
} from "../api/calendar";
import { useResourceLiveUpdates } from "./liveUpdates";

export const calendarKeys = {
	all: ["calendar"],
	range: (from, to, tag) => ["calendar", "range", from, to, tag ?? null],
	detail: (id) => ["calendar", "detail", id],
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
		onSuccess: () => qc.invalidateQueries({ queryKey: calendarKeys.all }),
	});
};

export const useUpdateEvent = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateEvent,
		onSuccess: (data) => {
			if (data?.id) qc.setQueryData(calendarKeys.detail(data.id), data);
			qc.invalidateQueries({ queryKey: calendarKeys.all });
		},
	});
};

export const useDeleteEvent = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteEvent,
		onSuccess: () => qc.invalidateQueries({ queryKey: calendarKeys.all }),
	});
};

// ── Live updates (SSE) ──────────────────────────────────────────────────────
//
// Subscribes to the backend calendar event stream so this tab reflects changes
// made elsewhere. Any event refetches the whole calendar family (queries are
// keyed by visible range). Mount once near the calendar view root.
export const useCalendarLiveUpdates = () =>
	useResourceLiveUpdates({
		path: "/admin/calendar/stream",
		event: "event",
		queryKey: calendarKeys.all,
	});
