import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createEvent,
	deleteEvent,
	fetchEvent,
	fetchEvents,
	updateEvent,
} from "../api/calendarApi";
import { useResourceLiveUpdates } from "./liveUpdates";

export const calendarKeys = {
	all: ["calendar"],
	range: (from, to, tag) => ["calendar", "range", from, to, tag ?? null],
	detail: (id) => ["calendar", "detail", id],
};

// Single event by id — used for deep-linking (Calendar route param eventId)
// when the event falls outside the loaded window.
export const useCalendarEvent = (id) =>
	useQuery({
		queryKey: calendarKeys.detail(id),
		queryFn: () => fetchEvent(id),
		enabled: !!id,
	});

export const useCalendarEvents = ({ from, to, tag } = {}, options = {}) =>
	useQuery({
		queryKey: calendarKeys.range(from, to, tag),
		queryFn: () => fetchEvents({ from, to, tag }),
		enabled: !!from && !!to,
		keepPreviousData: true,
		staleTime: 30_000,
		...options,
	});

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
		onSuccess: () => qc.invalidateQueries({ queryKey: calendarKeys.all }),
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
// Subscribes to the backend calendar event stream so this device reflects
// changes made elsewhere. Any event refetches the whole calendar family (queries
// are keyed by visible range). Mount once near the calendar screen root.
export const useCalendarLiveUpdates = () => {
	const qc = useQueryClient();
	useResourceLiveUpdates({
		path: "/admin/calendar/stream",
		event: "event",
		queryClient: qc,
		queryKey: calendarKeys.all,
	});
};
