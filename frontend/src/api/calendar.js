import axiosInstance from "./axiosInstance";

// ── Calendar events ─────────────────────────────────────────────────────────
//
// `from`/`to` are UTC ISO instants computed from the user's local visible
// window (see utils/dateTime + the plan's timezone note).

export const fetchEvents = async ({ from, to, tag } = {}) => {
	const { data } = await axiosInstance.get("/admin/calendar/events", {
		params: { from, to, tag },
	});
	return data;
};

export const fetchEvent = async (id) => {
	const { data } = await axiosInstance.get(`/admin/calendar/events/${id}`);
	return data;
};

export const createEvent = async (payload) => {
	const { data } = await axiosInstance.post("/admin/calendar/events", payload);
	return data;
};

export const updateEvent = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(
		`/admin/calendar/events/${id}`,
		payload,
	);
	return data;
};

export const deleteEvent = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/calendar/events/${id}`);
	return data;
};
