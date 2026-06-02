import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createEvent,
	deleteEvent,
	fetchEvents,
	updateEvent,
} from "../api/calendarApi";

export const calendarKeys = {
	all: ["calendar"],
	range: (from, to, tag) => ["calendar", "range", from, to, tag ?? null],
};

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
