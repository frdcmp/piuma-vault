import { CHAT_MIN } from "../store/chatDockStore";

// Column-fitting rules for the workspace shell (Notes, Tasks, Calendar,
// Storage). The shell can show up to three columns — page rail | page content |
// chat — but the rail and the chat are fixed-width, so on a narrow window they
// would starve the content column down to nothing. These helpers pick a tier:
// columns shrink toward their own minimum first, and only when that is not
// enough does a column drop out (the rail into an overlay drawer, then the chat
// into a full-screen panel).

/** Narrowest the page's own content column (editor / list / grid) may get. */
export const CONTENT_MIN = 460;

/** Width of a drag-resizer between two columns (see the *-resizer rules). */
export const RESIZER_W = 6;

/**
 * How the chat dock should render. "overlay" means not even [content | chat]
 * fits, so the chat takes the whole screen; "column" means side by side.
 */
export function chatDockMode(viewportWidth, isPhone) {
	if (isPhone) return "overlay";
	return viewportWidth - CHAT_MIN - RESIZER_W < CONTENT_MIN
		? "overlay"
		: "column";
}

/**
 * Chat column width, shrunk from the user's stored preference so the page keeps
 * CONTENT_MIN — never below CHAT_MIN (below that we'd be in "overlay" anyway).
 * The stored width is left untouched, so widening the window restores it.
 */
export function chatColumnWidth(viewportWidth, storedWidth) {
	return Math.max(
		CHAT_MIN,
		Math.min(storedWidth, viewportWidth - CONTENT_MIN - RESIZER_W),
	);
}

/** Horizontal space the chat column takes from the page (0 when closed/overlaid). */
export function chatColumnSpace(viewportWidth, { open, width, isPhone }) {
	if (!open || chatDockMode(viewportWidth, isPhone) === "overlay") return 0;
	return chatColumnWidth(viewportWidth, width) + RESIZER_W;
}

/**
 * How a page's left rail (e.g. the notes tree) fits in `available` px — the
 * width left over once the chat column has taken its share. Shrinks the rail
 * toward `min`; when even that would leave the content under CONTENT_MIN the
 * rail is `collapsed` and the page should offer it as an overlay drawer.
 */
export function railLayout(available, storedWidth, min) {
	const max = available - CONTENT_MIN - RESIZER_W;
	if (max < min) return { collapsed: true, width: Math.min(storedWidth, min) };
	return { collapsed: false, width: Math.min(storedWidth, max) };
}
