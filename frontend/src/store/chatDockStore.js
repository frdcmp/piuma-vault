import { create } from "zustand";

// Single source of truth for the shared chat dock's *chrome* — whether it's
// open and how wide it is. The dock (chat/ChatDock.jsx) and the pages that host
// it (Notes, Storage, Tasks, Calendar via chat/WorkspaceShell.jsx) all read
// this, so opening the chat from a note's toolbar or the empty-state pill is a
// plain action call rather than prop-drilling / Outlet context.
//
// State is unified across pages — one open flag, one width — so the dock
// "follows you" between pages (the conversation itself is already global, kept
// by ChatPanel). Content/context wiring (the note-tab context chips) lives
// separately in notesWorkspaceStore; this store deliberately owns chrome only.

export const CHAT_MIN = 220;
export const CHAT_MAX = 860;
export const CHAT_DEFAULT = 360;

const OPEN_KEY = "piuma:chat-open";
const WIDTH_KEY = "piuma:chat-width";

export const clampWidth = (n) =>
	Math.min(CHAT_MAX, Math.max(CHAT_MIN, Math.round(n)));

const readBool = (key) => {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
};

const readWidth = () => {
	try {
		const raw = localStorage.getItem(WIDTH_KEY);
		const n = raw == null ? CHAT_DEFAULT : Number.parseInt(raw, 10);
		return clampWidth(Number.isFinite(n) ? n : CHAT_DEFAULT);
	} catch {
		return CHAT_DEFAULT;
	}
};

const persist = (key, value) => {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* localStorage unavailable */
	}
};

const useChatDockStore = create((set) => ({
	open: readBool(OPEN_KEY),
	width: readWidth(),
	// Transient — not persisted; true while the user drags the resizer.
	isResizing: false,

	openChat: () => {
		persist(OPEN_KEY, "1");
		set({ open: true });
	},
	closeChat: () => {
		persist(OPEN_KEY, "0");
		set({ open: false });
	},
	toggleChat: () =>
		set((state) => {
			const open = !state.open;
			persist(OPEN_KEY, open ? "1" : "0");
			return { open };
		}),

	setWidth: (n) => {
		const width = clampWidth(n);
		persist(WIDTH_KEY, String(width));
		set({ width });
	},
	resetWidth: () => {
		persist(WIDTH_KEY, String(CHAT_DEFAULT));
		set({ width: CHAT_DEFAULT });
	},
	setResizing: (b) => set({ isResizing: !!b }),
}));

export default useChatDockStore;
