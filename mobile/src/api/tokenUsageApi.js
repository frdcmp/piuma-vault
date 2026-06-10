import axiosInstance from "./axiosInstance";

// Aggregated LLM token-usage analytics. Optional { from, to, source, model }
// filters; blank values are dropped. Backend: rust/src/apps/agents/usage.rs.
export const getTokenUsage = async (params = {}) => {
	const clean = Object.fromEntries(
		Object.entries(params).filter(([, v]) => v != null && v !== ""),
	);
	const { data } = await axiosInstance.get("/agents/usage", { params: clean });
	return data;
};
