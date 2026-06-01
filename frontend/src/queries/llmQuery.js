import { useMutation } from "@tanstack/react-query";
import { chatWithLLM } from "../api/llm";

// Query Keys
export const llmKeys = {
	all: ["llm"],
	chat: () => [...llmKeys.all, "chat"],
};

// Hook for LLM chat mutation
export const useChatWithLLM = () => {
	return useMutation({
		mutationFn: ({ service, model, message, history }) =>
			chatWithLLM(service, model, message, history),
	});
};
