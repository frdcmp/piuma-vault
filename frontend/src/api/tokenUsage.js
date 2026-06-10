import axiosInstance from "./axiosInstance";

/**
 * Fetch aggregated token-usage analytics.
 * @param {{ from?: string, to?: string, source?: string, model?: string }} params
 * @returns {Promise<{summary: object, by_model: object[], by_source: object[], by_day: object[]}>}
 */
export const getTokenUsage = async (params = {}) => {
	const clean = Object.fromEntries(
		Object.entries(params).filter(([, v]) => v != null && v !== ""),
	);
	const response = await axiosInstance.get("/agents/usage", { params: clean });
	return response.data;
};
