import { useMutation, useQuery } from "@tanstack/react-query";
import { chatWithAgent, listAgents } from "../api/agents";

export const agentsKeys = {
	all: ["agents"],
	list: () => [...agentsKeys.all, "list"],
	chat: (name) => [...agentsKeys.all, "chat", name],
};

export const useAgents = (options = {}) =>
	useQuery({
		queryKey: agentsKeys.list(),
		queryFn: listAgents,
		staleTime: 5 * 60 * 1000,
		...options,
	});

/**
 * Hook for chatting with a specific agent.
 * Usage:
 *   const chat = useChatWithAgent("piuma");
 *   chat.mutate({ message, history, service, model });
 */
export const useChatWithAgent = (name) =>
	useMutation({
		mutationKey: agentsKeys.chat(name),
		mutationFn: (payload) => chatWithAgent(name, payload),
	});
