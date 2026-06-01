import axiosInstance from "./axiosInstance";

/**
 * List public LLM agents available on the backend.
 * Returns: [{ name, display_name, description, default_provider, default_model, allowed_providers, public }]
 */
export const listAgents = async () => {
	const response = await axiosInstance.get("/llm/agents");
	return response.data;
};

/**
 * Chat with a registered agent by name.
 *
 * @param {string} name    Agent slug (e.g. "piuma").
 * @param {object} payload { message, history?, service?, model? }
 */
export const chatWithAgent = async (name, payload) => {
	const response = await axiosInstance.post(
		`/llm/agents/${encodeURIComponent(name)}/chat`,
		payload,
	);
	return response.data;
};
