import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	deletePigeonRule,
	disconnectPigeon,
	draftPigeonReply,
	fetchPigeonConnections,
	fetchPigeonConnectLink,
	fetchPigeonContact,
	fetchPigeonContacts,
	fetchPigeonConversation,
	fetchPigeonConversations,
	fetchPigeonGeneral,
	fetchPigeonItems,
	fetchPigeonPairing,
	fetchPigeonRuleRuns,
	fetchPigeonRules,
	fetchPigeonSettings,
	fetchPigeonSummary,
	learnAllPigeonContacts,
	learnPigeonContact,
	markPigeonHandled,
	markPigeonRead,
	mergePigeonContacts,
	pressPigeonCard,
	sendPigeonMessage,
	setPigeonContact,
	setPigeonContactNote,
	setPigeonContactSwitches,
	setPigeonConversationSwitches,
	setPigeonRule,
	setPigeonSettings,
	tryPigeonRule,
} from "../api/pigeon";
import { useResourceLiveUpdates } from "./liveUpdates";

// The chat list and a chat's messages come a page at a time.
const LIST_PAGE = 50;
const ITEMS_PAGE = 50;

export const pigeonKeys = {
	all: ["pigeon"],
	lists: () => ["pigeon", "conversations"],
	list: (params) => ["pigeon", "conversations", params ?? {}],
	conversation: (id) => ["pigeon", "conversation", id],
	items: (id) => ["pigeon", "items", id],
	summary: (id) => ["pigeon", "summary", id],
	general: () => ["pigeon", "general"],
	contacts: (q) => ["pigeon", "contacts", q ?? ""],
	contact: (id) => ["pigeon", "contact", id],
	rules: () => ["pigeon", "rules"],
	ruleRuns: (id) => ["pigeon", "rule-runs", id],
	settings: () => ["pigeon", "settings"],
	connections: () => ["pigeon", "connections"],
	pairing: (connector) => ["pigeon", "pairing", connector],
};

// ── Live updates ────────────────────────────────────────────────────────────
//
// The backend streams `{kind, id}`; everything is re-fetched through the
// normal routes. A conversation event refreshes that chat and the list.
const applyPigeonEvent = (qc, kind, id) => {
	const inv = (queryKey) => qc.invalidateQueries({ queryKey });
	switch (kind) {
		case "conversation":
			inv(pigeonKeys.lists());
			if (id) {
				inv(pigeonKeys.conversation(id));
				inv(pigeonKeys.items(id));
			}
			return;
		case "conversations":
			inv(pigeonKeys.lists());
			inv(["pigeon", "contacts"]);
			inv(["pigeon", "contact"]);
			return;
		case "news":
			inv(pigeonKeys.general());
			inv(pigeonKeys.lists());
			return;
		case "settings":
			inv(pigeonKeys.settings());
			inv(["pigeon", "conversation"]);
			inv(["pigeon", "contacts"]);
			return;
		case "connections":
			inv(pigeonKeys.settings());
			inv(pigeonKeys.connections());
			return;
		case "message_in":
			// the phone's push; the conversation event refreshes the chat
			return;
		default:
			inv(pigeonKeys.all);
	}
};

export function usePigeonLiveUpdates() {
	useResourceLiveUpdates({
		path: "/admin/pigeon/events",
		event: "pigeon",
		queryKey: pigeonKeys.all,
		onEvent: applyPigeonEvent,
	});
}

// ── Chats ───────────────────────────────────────────────────────────────────

// params: { filter?: "needs", connector?, q? }
export function usePigeonConversations(params = {}) {
	return useInfiniteQuery({
		queryKey: pigeonKeys.list(params),
		queryFn: ({ pageParam }) =>
			fetchPigeonConversations({
				...params,
				before: pageParam ?? undefined,
				limit: LIST_PAGE,
			}),
		initialPageParam: null,
		getNextPageParam: (last) => {
			const rows = last?.conversations ?? [];
			return rows.length === LIST_PAGE ? rows.at(-1)?.last_item_at : undefined;
		},
		select: (data) => data.pages.flatMap((p) => p.conversations ?? []),
	});
}

export function usePigeonConversation(id) {
	return useQuery({
		queryKey: pigeonKeys.conversation(id),
		queryFn: () => fetchPigeonConversation(id),
		enabled: !!id,
	});
}

// Pages run newest → older; `select` gives the messages and news oldest first.
export function usePigeonItems(id) {
	return useInfiniteQuery({
		queryKey: pigeonKeys.items(id),
		queryFn: ({ pageParam }) =>
			fetchPigeonItems({
				id,
				before: pageParam ?? undefined,
				limit: ITEMS_PAGE,
			}),
		initialPageParam: null,
		getNextPageParam: (last) => (last?.more ? last.items?.[0]?.at : undefined),
		enabled: !!id,
		select: (data) => {
			const pages = [...data.pages].reverse();
			return {
				items: pages.flatMap((p) => p.items ?? []),
				news: pages.flatMap((p) => p.news ?? []),
			};
		},
	});
}

export function usePigeonSummary(id, enabled) {
	return useQuery({
		queryKey: pigeonKeys.summary(id),
		queryFn: () => fetchPigeonSummary(id),
		enabled: !!id && !!enabled,
		staleTime: 5 * 60 * 1000,
	});
}

export function usePigeonGeneral() {
	return useQuery({
		queryKey: pigeonKeys.general(),
		queryFn: fetchPigeonGeneral,
	});
}

const useChatMutation = (fn) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: (_d, vars) => {
			const id = typeof vars === "object" ? vars?.id : vars;
			qc.invalidateQueries({ queryKey: pigeonKeys.lists() });
			if (id) {
				qc.invalidateQueries({ queryKey: pigeonKeys.conversation(id) });
				qc.invalidateQueries({ queryKey: pigeonKeys.items(id) });
			}
		},
	});
};

export const useSendPigeonMessage = () => useChatMutation(sendPigeonMessage);
export const useMarkPigeonHandled = () => useChatMutation(markPigeonHandled);
export const useDraftPigeonReply = () => useChatMutation(draftPigeonReply);
export const useSetPigeonConversationSwitches = () =>
	useChatMutation(setPigeonConversationSwitches);

export function useMarkPigeonRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: markPigeonRead,
		onSuccess: () => qc.invalidateQueries({ queryKey: pigeonKeys.lists() }),
	});
}

// A card's button. `conversationId` (null for General's) says what to refresh.
export function usePressPigeonCard() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ conversationId: _c, ...card }) => pressPigeonCard(card),
		onSuccess: (_d, { conversationId }) => {
			qc.invalidateQueries({ queryKey: pigeonKeys.lists() });
			if (conversationId) {
				qc.invalidateQueries({
					queryKey: pigeonKeys.conversation(conversationId),
				});
				qc.invalidateQueries({ queryKey: pigeonKeys.items(conversationId) });
			} else {
				qc.invalidateQueries({ queryKey: pigeonKeys.general() });
			}
		},
	});
}

// ── People ──────────────────────────────────────────────────────────────────

export function usePigeonContacts(q) {
	return useQuery({
		queryKey: pigeonKeys.contacts(q),
		queryFn: () => fetchPigeonContacts({ q: q || undefined, limit: 500 }),
		select: (d) => d?.contacts ?? [],
	});
}

export function usePigeonContact(id) {
	return useQuery({
		queryKey: pigeonKeys.contact(id),
		queryFn: () => fetchPigeonContact(id),
		enabled: !!id,
	});
}

const usePeopleMutation = (fn) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["pigeon", "contacts"] });
			qc.invalidateQueries({ queryKey: ["pigeon", "contact"] });
			qc.invalidateQueries({ queryKey: ["pigeon", "conversation"] });
			qc.invalidateQueries({ queryKey: pigeonKeys.lists() });
		},
	});
};

export const useSetPigeonContact = () => usePeopleMutation(setPigeonContact);
export const useSetPigeonContactNote = () =>
	usePeopleMutation(setPigeonContactNote);
export const useMergePigeonContacts = () =>
	usePeopleMutation(mergePigeonContacts);
export const useSetPigeonContactSwitches = () =>
	usePeopleMutation(setPigeonContactSwitches);
export const useLearnPigeonContact = () =>
	usePeopleMutation(learnPigeonContact);
export const useLearnAllPigeonContacts = () =>
	useMutation({ mutationFn: learnAllPigeonContacts });

// ── Rules ───────────────────────────────────────────────────────────────────

export function usePigeonRules() {
	return useQuery({
		queryKey: pigeonKeys.rules(),
		queryFn: fetchPigeonRules,
		select: (d) => d?.rules ?? [],
	});
}

export function usePigeonRuleRuns(id) {
	return useQuery({
		queryKey: pigeonKeys.ruleRuns(id),
		queryFn: () => fetchPigeonRuleRuns(id),
		enabled: id != null,
		select: (d) => d?.runs ?? [],
	});
}

const useRuleMutation = (fn) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: pigeonKeys.rules() });
			qc.invalidateQueries({ queryKey: ["pigeon", "rule-runs"] });
		},
	});
};

export const useSetPigeonRule = () => useRuleMutation(setPigeonRule);
export const useDeletePigeonRule = () => useRuleMutation(deletePigeonRule);
export const useTryPigeonRule = () => useRuleMutation(tryPigeonRule);

// ── Settings and connections ────────────────────────────────────────────────

export function usePigeonSettings() {
	return useQuery({
		queryKey: pigeonKeys.settings(),
		queryFn: fetchPigeonSettings,
	});
}

export function useSetPigeonSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: setPigeonSettings,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: pigeonKeys.settings() });
			qc.invalidateQueries({ queryKey: ["pigeon", "conversation"] });
		},
	});
}

export function usePigeonConnections() {
	return useQuery({
		queryKey: pigeonKeys.connections(),
		queryFn: fetchPigeonConnections,
		select: (d) => d?.connections ?? [],
	});
}

export function useDisconnectPigeon() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: disconnectPigeon,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: pigeonKeys.connections() });
			qc.invalidateQueries({ queryKey: pigeonKeys.settings() });
		},
	});
}

export const usePigeonConnectLink = () =>
	useMutation({ mutationFn: fetchPigeonConnectLink });

// WhatsApp's QR, polled while the pairing dialog is open (the code turns over).
export function usePigeonPairing(connector, open) {
	const qc = useQueryClient();
	return useQuery({
		queryKey: pigeonKeys.pairing(connector),
		queryFn: async () => {
			const p = await fetchPigeonPairing(connector);
			if (p?.state === "connected") {
				qc.invalidateQueries({ queryKey: pigeonKeys.connections() });
				qc.invalidateQueries({ queryKey: pigeonKeys.settings() });
			}
			return p;
		},
		enabled: !!connector && !!open,
		refetchInterval: (q) =>
			q.state.data?.state === "connected" ? false : 3000,
		staleTime: 0,
		gcTime: 0,
	});
}
