import axiosInstance from "./axiosInstance";

/**
 * Admin memory dashboard API — read views over the agent memory system
 * (L1 always-in-context, L2 semantic store, L3 conversation retrieval, L4
 * derived) plus moderation actions.
 * Backend: rust/src/apps/agents/memory_admin.rs.
 */

/** L1 usage + L2/L4 aggregate stats for one agent. */
export const getMemoryOverview = async (agent = "vault_agent") => {
	const res = await axiosInstance.get("/agents/memory/overview", {
		params: { agent },
	});
	return res.data;
};

/** Filterable list of L2/L4 entries (embedding omitted). */
export const listMemoryEntries = async (filters = {}) => {
	const res = await axiosInstance.get("/agents/memory/entries", {
		params: filters,
	});
	return res.data;
};

/** Phase 0 inspector: what was retrieved per turn. */
export const listTurnLogs = async (filters = {}) => {
	const res = await axiosInstance.get("/agents/memory/turn-logs", {
		params: filters,
	});
	return res.data;
};

/** L3 conversation retrieval: full-text search over past chat history. */
export const searchConversations = async (filters = {}) => {
	const res = await axiosInstance.get("/agents/memory/conversations", {
		params: filters,
	});
	return res.data;
};

export const confirmMemoryEntry = async (id) => {
	const res = await axiosInstance.post(`/agents/memory/entries/${id}/confirm`);
	return res.data;
};

export const rejectMemoryEntry = async (id) => {
	const res = await axiosInstance.post(`/agents/memory/entries/${id}/reject`);
	return res.data;
};

export const deleteMemoryEntry = async (id) => {
	const res = await axiosInstance.delete(`/agents/memory/entries/${id}`);
	return res.data;
};
