import axiosInstance from "./axiosInstance";

// Agent memory dashboard — read views over the layered memory system (L1
// always-in-context, L2 semantic store, L3 conversation retrieval, L4 derived)
// plus moderation actions. Backend: rust/src/apps/agents/memory_admin.rs.

// L1 usage + L2/L4 aggregate stats for one agent.
export const getMemoryOverview = async (agent = "vault_agent") => {
	const { data } = await axiosInstance.get("/agents/memory/overview", {
		params: { agent },
	});
	return data;
};

// Filterable list of L2/L4 entries (status / source / category / search).
export const listMemoryEntries = async (filters = {}) => {
	const clean = Object.fromEntries(
		Object.entries(filters).filter(([, v]) => v != null && v !== ""),
	);
	const { data } = await axiosInstance.get("/agents/memory/entries", {
		params: clean,
	});
	return data;
};

export const confirmMemoryEntry = async (id) => {
	const { data } = await axiosInstance.post(
		`/agents/memory/entries/${id}/confirm`,
	);
	return data;
};

export const rejectMemoryEntry = async (id) => {
	const { data } = await axiosInstance.post(
		`/agents/memory/entries/${id}/reject`,
	);
	return data;
};

export const deleteMemoryEntry = async (id) => {
	const { data } = await axiosInstance.delete(`/agents/memory/entries/${id}`);
	return data;
};
