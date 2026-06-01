import { create } from "zustand";

// Bridges the active note editor's toolbar state up to the notes layout, so
// the editor's commands (save status, search, rename, share, chat, close) can
// live in the shared top bar next to the tabs instead of a separate header
// row. NoteEditor publishes here while mounted on desktop and clears on
// unmount; NotesLayout reads it to render <NoteControls/>.
//
// Search-in-page is shared state too: the popover under the 🔍 icon
// (NoteControls) owns the query/navigation UI, while NoteEditor feeds the
// query down to the Milkdown editor and writes match counts back up.
const useNoteControlsStore = create((set) => ({
	present: false,
	noteId: null,
	saveStatus: "idle",

	// Search-in-page state, driven by the popover and read by the editor.
	searchOpen: false,
	searchQuery: "",
	searchAction: null,
	searchCount: 0,
	searchIndex: 0,

	publish: (patch) => set({ present: true, ...patch }),
	clear: () =>
		set({
			present: false,
			noteId: null,
			saveStatus: "idle",
			searchOpen: false,
			searchQuery: "",
			searchAction: null,
			searchCount: 0,
			searchIndex: 0,
		}),

	openSearch: () => set({ searchOpen: true, searchQuery: "" }),
	closeSearch: () => set({ searchOpen: false, searchQuery: "" }),
	setSearchQuery: (searchQuery) => set({ searchQuery }),
	setSearchAction: (searchAction) => set({ searchAction }),
	setSearchResults: (searchCount, searchIndex) =>
		set({ searchCount, searchIndex }),
}));

export default useNoteControlsStore;
