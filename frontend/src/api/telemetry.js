// Browser-side error reporting → POST /telemetry/client.
//
// Until this existed the frontend had no telemetry at all: a TypeError in the
// composer or a broken public share page died in the user's console and never
// reached the backend's ingest pipeline. `reportClientError()` closes that gap.
//
// Three rules shape the implementation, all of them about not making a bad
// situation worse:
//
//   1. It never throws and never reports its own failures. A reporting bug
//      that reports itself is an infinite loop wearing a bug's clothes.
//   2. It deduplicates and caps. A render error fires every frame; we want to
//      know it happened, not receive ten thousand copies.
//   3. It uses plain `fetch`, NOT the shared axios instance — that one's 401
//      interceptor redirects to the login page, which would be a spectacular
//      way for an error report from a public share page to eat the session.
//
// Auth is optional by design (see the backend handler): the token is attached
// when there is one, so signed-in errors are attributable, and anonymous
// reports from public pages still land.

const ENDPOINT = `${import.meta.env.BASE_URL}api/v1/telemetry/client`;

// Flush window. Long enough to coalesce a burst (one broken render usually
// throws several times in quick succession), short enough that a report still
// goes out before the user navigates away.
const FLUSH_MS = 2000;
const MAX_BATCH = 20;

// Per-session ceiling. Past this we stop reporting entirely: whatever is wrong
// is systemic, and the first hundred events already said so.
const MAX_PER_SESSION = 100;

// A given message is reported at most once per this window.
const DEDUPE_MS = 60_000;

let queue = [];
let timer = null;
let sent = 0;
const seen = new Map(); // message → last reported timestamp

const flush = () => {
	timer = null;
	if (!queue.length) return;
	const events = queue;
	queue = [];

	const headers = { "Content-Type": "application/json" };
	try {
		const token = localStorage.getItem("token");
		if (token) headers.Authorization = `Bearer ${token}`;
	} catch {
		// localStorage can throw in a locked-down browser; report anonymously.
	}

	try {
		fetch(ENDPOINT, {
			method: "POST",
			headers,
			body: JSON.stringify({ events }),
			// Survives the page being torn down mid-flight, which is exactly
			// when the interesting errors happen.
			keepalive: true,
		}).catch(() => {});
	} catch {
		// Never let reporting break the caller.
	}
};

/**
 * Report a client-side error. Fire-and-forget — returns nothing, throws never.
 *
 * @param {string} category  grouping, e.g. "attachment" | "window"
 * @param {unknown} error    an Error, or anything stringifiable
 * @param {object} [opts]
 * @param {string} [opts.type]      event type, default "error"
 * @param {string} [opts.severity]  "error" (default) | "warn"
 * @param {object} [opts.attributes] extra context (file name, mime, …)
 */
export const reportClientError = (category, error, opts = {}) => {
	try {
		if (sent >= MAX_PER_SESSION) return;

		const message = error?.stack || error?.message || String(error ?? "");
		if (!message) return;

		const now = Date.now();
		const last = seen.get(message);
		if (last && now - last < DEDUPE_MS) return;
		seen.set(message, now);
		// Bound the dedupe map; distinct messages in one session are few.
		if (seen.size > 200) seen.clear();

		sent += 1;
		queue.push({
			category,
			event_type: opts.type || "error",
			severity: opts.severity === "warn" ? "warn" : "error",
			message,
			route: window.location?.pathname || "",
			error_code: error?.name || "",
			attributes: opts.attributes,
		});

		if (queue.length >= MAX_BATCH) {
			if (timer) clearTimeout(timer);
			flush();
			return;
		}
		timer ??= setTimeout(flush, FLUSH_MS);
	} catch {
		// Reporting must never be the thing that breaks.
	}
};

/**
 * Catch what nothing else caught: uncaught exceptions and rejected promises
 * with no handler. Call once, at startup.
 */
export const installGlobalErrorReporting = () => {
	window.addEventListener("error", (e) => {
		// Failed <img>/<script> loads also fire "error" on the element and
		// bubble here with no `error` property — not worth a telemetry row.
		if (!e.error) return;
		reportClientError("window", e.error, { type: "uncaught" });
	});

	window.addEventListener("unhandledrejection", (e) => {
		reportClientError("window", e.reason, { type: "unhandledrejection" });
	});

	// Anything still queued when the tab goes away.
	window.addEventListener("pagehide", flush);
};
