import axiosInstance from "./axiosInstance";

export const chatWithLLM = async (service, model, message, history = []) => {
	try {
		const response = await axiosInstance.post("/llm/chat", {
			service,
			model,
			message,
			history,
		});
		return response.data;
	} catch (error) {
		console.error("Error chatting with LLM:", error);
		throw error;
	}
};
