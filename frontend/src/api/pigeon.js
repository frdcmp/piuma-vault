import axiosInstance from "./axiosInstance";

// ── The Inbox (Pigeon) ──────────────────────────────────────────────────────
//
// Pigeon brings in what people send (WhatsApp, Instagram, Gmail…), sorts it and
// proposes replies and vault tasks that wait for a tap. Everything is the
// signed-in user's own (`inbox.read` / `inbox.write`).

const BASE = "/admin/pigeon";

// ── Chats ───────────────────────────────────────────────────────────────────

export const fetchPigeonConversations = async (params = {}) => {
	const { data } = await axiosInstance.get(`${BASE}/conversations`, {
		params,
	});
	return data;
};

export const fetchPigeonConversation = async (id) => {
	const { data } = await axiosInstance.get(`${BASE}/conversations/${id}`);
	return data;
};

export const fetchPigeonItems = async ({ id, before, limit }) => {
	const { data } = await axiosInstance.get(
		`${BASE}/conversations/${id}/items`,
		{ params: { before, limit } },
	);
	return data;
};

export const sendPigeonMessage = async ({ id, text }) => {
	const { data } = await axiosInstance.post(
		`${BASE}/conversations/${id}/send`,
		{ text },
	);
	return data;
};

export const markPigeonRead = async (id) => {
	const { data } = await axiosInstance.post(`${BASE}/conversations/${id}/read`);
	return data;
};

export const markPigeonHandled = async (id) => {
	const { data } = await axiosInstance.post(
		`${BASE}/conversations/${id}/handled`,
	);
	return data;
};

export const draftPigeonReply = async ({ id, instructions }) => {
	const { data } = await axiosInstance.post(
		`${BASE}/conversations/${id}/draft`,
		{ instructions: instructions || null },
	);
	return data;
};

// A reply's words for your own box (no card): { text }.
export const composePigeonReply = async ({ id, instructions }) => {
	const { data } = await axiosInstance.post(
		`${BASE}/conversations/${id}/draft`,
		{ instructions: instructions || null, compose: true },
	);
	return data;
};

export const fetchPigeonSummary = async (id) => {
	const { data } = await axiosInstance.get(
		`${BASE}/conversations/${id}/summary`,
	);
	return data;
};

// switches: { reply?: off|ask|auto|inherit, alerts?: all|smart|quiet|off|inherit }
export const setPigeonConversationSwitches = async ({ id, ...switches }) => {
	const { data } = await axiosInstance.put(
		`${BASE}/conversations/${id}/switches`,
		switches,
	);
	return data;
};

export const fetchPigeonGeneral = async () => {
	const { data } = await axiosInstance.get(`${BASE}/general`);
	return data;
};

// A card's button: { kind, id, button, text? } (text: a draft's edited words,
// or an answer in the user's own words).
export const pressPigeonCard = async ({ kind, id, button, text }) => {
	const { data } = await axiosInstance.post(`${BASE}/cards/${kind}/${id}`, {
		button,
		text: text ?? null,
	});
	return data;
};

// ── People ──────────────────────────────────────────────────────────────────

export const fetchPigeonContacts = async (params = {}) => {
	const { data } = await axiosInstance.get(`${BASE}/contacts`, { params });
	return data;
};

export const fetchPigeonContact = async (id) => {
	const { data } = await axiosInstance.get(`${BASE}/contacts/${id}`);
	return data;
};

// Create (no contact_id) or change a contact.
export const setPigeonContact = async (payload) => {
	const { data } = await axiosInstance.put(`${BASE}/contacts`, payload);
	return data;
};

export const setPigeonContactNote = async ({ id, note }) => {
	const { data } = await axiosInstance.put(`${BASE}/contacts/${id}/note`, {
		note,
	});
	return data;
};

export const mergePigeonContacts = async ({ id, mergeId }) => {
	const { data } = await axiosInstance.post(`${BASE}/contacts/${id}/merge`, {
		merge_id: mergeId,
	});
	return data;
};

export const setPigeonContactSwitches = async ({ id, ...switches }) => {
	const { data } = await axiosInstance.put(
		`${BASE}/contacts/${id}/switches`,
		switches,
	);
	return data;
};

export const learnPigeonContact = async ({ id, days }) => {
	const { data } = await axiosInstance.post(`${BASE}/contacts/${id}/learn`, {
		days,
	});
	return data;
};

export const learnAllPigeonContacts = async ({ days } = {}) => {
	const { data } = await axiosInstance.post(`${BASE}/contacts/learn`, {
		days,
	});
	return data;
};

// ── Chats by person ─────────────────────────────────────────────────────────
//
// A person's chat is all their threads (WhatsApp, Instagram, email…) as one;
// a group stays its own chat.

// params: { filter?: "needs", connector?, q?, before?, limit? } → { chats }
export const fetchPigeonChats = async (params = {}) => {
	const { data } = await axiosInstance.get(`${BASE}/chats`, { params });
	return data;
};

export const fetchPigeonPersonChat = async (id) => {
	const { data } = await axiosInstance.get(`${BASE}/chats/person/${id}`);
	return data;
};

// A person's messages across their threads, or one channel's: { items, news, senders, more }.
export const fetchPigeonPersonItems = async ({
	id,
	connector,
	before,
	limit,
}) => {
	const { data } = await axiosInstance.get(`${BASE}/chats/person/${id}/items`, {
		params: { connector, before, limit },
	});
	return data;
};

export const markPigeonPersonRead = async (id) => {
	const { data } = await axiosInstance.post(`${BASE}/chats/person/${id}/read`);
	return data;
};

export const markPigeonPersonHandled = async (id) => {
	const { data } = await axiosInstance.post(
		`${BASE}/chats/person/${id}/handled`,
	);
	return data;
};

// An email as it was sent: { html } (null when it has none), fetched from Gmail.
export const fetchPigeonItemHtml = async (id) => {
	const { data } = await axiosInstance.get(`${BASE}/items/${id}/html`);
	return data;
};

// A message's file, to save on this computer (the browser's download).
export const downloadPigeonMedia = async ({ item, file, name }) => {
	const { data } = await axiosInstance.get(
		`${BASE}/items/${item}/media/${file}`,
		{ responseType: "blob" },
	);
	const url = URL.createObjectURL(data);
	const a = document.createElement("a");
	a.href = url;
	a.download = name || "file";
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

// Names from the WhatsApp address book: { address_book, named, added, … }.
export const importPigeonWhatsappNames = async () => {
	const { data } = await axiosInstance.post(`${BASE}/contacts/whatsapp`);
	return data;
};

// ── Rules ───────────────────────────────────────────────────────────────────

export const fetchPigeonRules = async () => {
	const { data } = await axiosInstance.get(`${BASE}/rules`);
	return data;
};

export const setPigeonRule = async (payload) => {
	const { data } = await axiosInstance.put(`${BASE}/rules`, payload);
	return data;
};

export const deletePigeonRule = async (id) => {
	const { data } = await axiosInstance.delete(`${BASE}/rules/${id}`);
	return data;
};

export const tryPigeonRule = async ({ id, limit, apply }) => {
	const { data } = await axiosInstance.post(`${BASE}/rules/${id}/try`, {
		limit,
		apply: !!apply,
	});
	return data;
};

export const fetchPigeonRuleRuns = async (id) => {
	const { data } = await axiosInstance.get(`${BASE}/rules/${id}/runs`);
	return data;
};

// ── Settings and connections ────────────────────────────────────────────────

export const fetchPigeonSettings = async () => {
	const { data } = await axiosInstance.get(`${BASE}/settings`);
	return data;
};

export const setPigeonSettings = async (payload) => {
	const { data } = await axiosInstance.put(`${BASE}/settings`, payload);
	return data;
};

export const fetchPigeonConnections = async () => {
	const { data } = await axiosInstance.get(`${BASE}/connections`);
	return data;
};

export const disconnectPigeon = async (id) => {
	const { data } = await axiosInstance.delete(`${BASE}/connections/${id}`);
	return data;
};

// A one-time link to connect an account (opened in the browser): { url }.
export const fetchPigeonConnectLink = async (connector) => {
	const { data } = await axiosInstance.post(
		`${BASE}/connections/${connector}/link`,
	);
	return data;
};

// Pairing with a code (WhatsApp's QR), polled while open.
export const fetchPigeonPairing = async (connector) => {
	const { data } = await axiosInstance.get(
		`${BASE}/connections/${connector}/pairing`,
	);
	return data;
};
