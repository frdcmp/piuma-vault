import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createConversation,
	createModel,
	createProvider,
	deleteConversation,
	deleteModel,
	deleteProvider,
	fetchAgents,
	fetchAvailableModels,
	fetchConversation,
	fetchConversations,
	fetchDefaultAgent,
	fetchModels,
	fetchPersonas,
	fetchProfile,
	fetchProviders,
	setDefaultAgent,
	updateModel,
	updatePersona,
	updateProfile,
	updateProvider,
} from "../api/agentChatApi";

export const agentKeys = {
	all: ["agents"],
	agents: ["agents", "list"],
	providers: ["agents", "providers"],
	models: (providerId) => ["agents", "models", providerId],
	availableModels: (providerId) => ["agents", "available-models", providerId],
	profile: (agent) => ["agents", "profile", agent],
	personas: (agent) => ["agents", "personas", agent],
	conversations: (agent) => ["agents", "conversations", agent ?? null],
	conversation: (id) => ["agents", "conversation", id],
};

// ── Reads ────────────────────────────────────────────────────────────────────
export const useAgentList = (options = {}) =>
	useQuery({
		queryKey: agentKeys.agents,
		queryFn: fetchAgents,
		staleTime: 60_000,
		...options,
	});

export const useProviders = (options = {}) =>
	useQuery({
		queryKey: agentKeys.providers,
		queryFn: fetchProviders,
		...options,
	});

export const useDefaultAgent = (options = {}) =>
	useQuery({
		queryKey: ["agents", "default"],
		queryFn: fetchDefaultAgent,
		staleTime: 60_000,
		...options,
	});

export const useSetDefaultAgent = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: setDefaultAgent,
		onSuccess: (data) => qc.setQueryData(["agents", "default"], data),
	});
};

export const useModels = (providerId, options = {}) =>
	useQuery({
		queryKey: agentKeys.models(providerId),
		queryFn: () => fetchModels(providerId),
		enabled: !!providerId,
		...options,
	});

// Lazy by default — pass `enabled: true` (e.g. when the wire-id field is
// focused) so we only hit the provider API on demand. Cached briefly so
// re-focusing doesn't refetch every time.
export const useAvailableModels = (providerId, options = {}) =>
	useQuery({
		queryKey: agentKeys.availableModels(providerId),
		queryFn: () => fetchAvailableModels(providerId),
		enabled: false,
		staleTime: 60_000,
		retry: false,
		...options,
	});

export const useAgentProfile = (agent, options = {}) =>
	useQuery({
		queryKey: agentKeys.profile(agent),
		queryFn: () => fetchProfile(agent),
		enabled: !!agent,
		...options,
	});

export const useAgentPersonas = (agent, options = {}) =>
	useQuery({
		queryKey: agentKeys.personas(agent),
		queryFn: () => fetchPersonas(agent),
		enabled: !!agent,
		...options,
	});

export const useConversations = (agent, options = {}) =>
	useQuery({
		queryKey: agentKeys.conversations(agent),
		queryFn: () => fetchConversations(agent),
		...options,
	});

export const useConversation = (id, options = {}) =>
	useQuery({
		queryKey: agentKeys.conversation(id),
		queryFn: () => fetchConversation(id),
		enabled: !!id,
		...options,
	});

// ── Mutations ────────────────────────────────────────────────────────────────
const useInvalidate = (key) => {
	const qc = useQueryClient();
	return () => qc.invalidateQueries({ queryKey: key });
};

export const useCreateProvider = () => {
	const inv = useInvalidate(agentKeys.providers);
	return useMutation({ mutationFn: createProvider, onSuccess: inv });
};
export const useUpdateProvider = () => {
	const inv = useInvalidate(agentKeys.providers);
	return useMutation({ mutationFn: updateProvider, onSuccess: inv });
};
export const useDeleteProvider = () => {
	const inv = useInvalidate(agentKeys.providers);
	return useMutation({ mutationFn: deleteProvider, onSuccess: inv });
};

export const useCreateModel = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createModel,
		onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
	});
};
export const useUpdateModel = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateModel,
		onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
	});
};
export const useDeleteModel = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteModel,
		onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
	});
};

export const useUpdateAgentProfile = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateProfile,
		onSuccess: (data) =>
			qc.invalidateQueries({ queryKey: agentKeys.profile(data?.agent) }),
	});
};
export const useUpdatePersona = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updatePersona,
		onSuccess: (data) =>
			qc.invalidateQueries({ queryKey: agentKeys.personas(data?.agent) }),
	});
};

export const useCreateConversation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createConversation,
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: ["agents", "conversations"] }),
	});
};
export const useDeleteConversation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteConversation,
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: ["agents", "conversations"] }),
	});
};
