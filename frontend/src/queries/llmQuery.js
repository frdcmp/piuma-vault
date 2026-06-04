import { useMutation, useQuery } from "@tanstack/react-query";
import { chatWithLLM } from "../api/llm";
import { fetchOpenclawHistory } from "../api/openclawChat";

// Query Keys
export const llmKeys = {
	all: ["llm"],
	chat: () => [...llmKeys.all, "chat"],
	openclawHistory: (sessionKey) => [
		...llmKeys.all,
		"openclaw",
		"history",
		sessionKey,
	],
};

// Hook for LLM chat mutation
export const useChatWithLLM = () => {
	return useMutation({
		mutationFn: ({ service, model, message, history }) =>
			chatWithLLM(service, model, message, history),
	});
};

// Loads the conversation for `sessionKey` from the OpenClaw gateway. Keyed by
// the session key so rotating it (new chat) fetches a fresh, empty transcript.
// Window-focus refetch is disabled so it never clobbers an in-progress stream;
// the panel seeds its local state from this once per mount.
export const useOpenclawHistory = (sessionKey) =>
	useQuery({
		queryKey: llmKeys.openclawHistory(sessionKey),
		queryFn: ({ signal }) => fetchOpenclawHistory({ signal }),
		enabled: Boolean(sessionKey),
		staleTime: 0,
		refetchOnWindowFocus: false,
		retry: false,
	});
