import { useEffect } from "react";
import { AppState } from "react-native";
import EventSource from "react-native-sse";
import { refreshAccessToken } from "../api/axiosInstance";
import { useAuthStore } from "../stores/authStore";

const BASE_URL =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

// ── Multiplexed SSE live-updates ─────────────────────────────────────────────
//
// One shared EventSource per (path, event) stream, fanned out to every
// subscriber. Previously each hook opened its OWN socket to the same stream,
// so a single change invalidated the cache many times over and triggered a
// refetch storm: the Tasks screen subscribes to /admin/tasks/events twice
// (task lists + tag counts), and a native-stack keeps the Calendar screen
// mounted underneath — which subscribes again. Three+ sockets → 3× the
// refetches on every edit. Here all of them share one socket, and invalidations
// are deduped by query key and coalesced so a burst becomes a single refetch.
//
//  - `react-native-sse` (RN has no built-in EventSource).
//  - JWT in `Authorization: Bearer` (kept out of URLs/access logs), pulled from
//    the zustand auth store, refreshed via the shared single-flight refresh.
//  - On any event (or a reconnect after a gap) the stream's query keys are
//    invalidated so changes missed while disconnected aren't lost.

const channels = new Map(); // `${path}::${event}` -> channel state

// ── Self-echo suppression ────────────────────────────────────────────────────
//
// A mutation on THIS device invalidates its query family directly (in the
// mutation's onSuccess), and the backend then broadcasts the same change back
// over SSE — including to the device that made it. Without suppression that echo
// triggers a SECOND full refetch round right after the first, doubling every
// request on a local edit. Each mutation hook calls `markLocalChange(path)` in
// its `onMutate` (request start — the echo can arrive BEFORE onSuccess), so the
// matching echo arriving within SELF_ECHO_MS is dropped; the direct invalidation
// already covered it. Echoes from OTHER devices have no local marker and still
// refetch normally.
const SELF_ECHO_MS = 2500;
const lastLocalChange = new Map(); // sse path -> timestamp (ms)

export function markLocalChange(path) {
	lastLocalChange.set(path, Date.now());
}

export function isLocalEcho(path) {
	const t = lastLocalChange.get(path);
	return t !== undefined && Date.now() - t < SELF_ECHO_MS;
}

// Blunt, coalesced invalidate of every subscriber's family. Used only for
// reconnect/foreground backfill, where individual events can't be replayed so
// the whole family must refresh.
function fanout(ch) {
	if (ch.flushTimer) return;
	ch.flushTimer = setTimeout(() => {
		ch.flushTimer = null;
		for (const sub of ch.subs.values())
			sub.qc.invalidateQueries({ queryKey: sub.queryKey });
	}, 250);
}

// Apply ONE live {action,id} event. Subscribers with an `onEvent` patch their
// caches surgically from it; the rest fall back to a blunt family invalidate.
// A surgical handler that throws degrades to that same blunt invalidate.
function dispatchEvent(ch, payload) {
	for (const sub of ch.subs.values()) {
		if (sub.onEvent && payload?.id) {
			Promise.resolve(sub.onEvent(sub.qc, payload.action, payload.id)).catch(
				() => sub.qc.invalidateQueries({ queryKey: sub.queryKey }),
			);
		} else {
			sub.qc.invalidateQueries({ queryKey: sub.queryKey });
		}
	}
}

function closeEs(ch) {
	if (!ch.es) return;
	try {
		ch.es.removeAllEventListeners();
	} catch {
		/* ignore */
	}
	try {
		ch.es.close();
	} catch {
		/* ignore */
	}
	ch.es = null;
}

function openChannel(ch) {
	const token = useAuthStore.getState().token;
	if (!token) return; // logged out; foreground/next subscribe retries

	const es = new EventSource(`${BASE_URL}${ch.path}`, {
		headers: { Authorization: `Bearer ${token}` },
		// react-native-sse has its own retry — disable it so our manual loop is
		// the single source of reconnect logic.
		pollingInterval: 0,
	});
	ch.es = es;

	es.addEventListener(ch.event, (evt) => {
		if (evt?.data === undefined) return;
		// Drop the echo of a change this device just made — its mutation already
		// patched the cache. Reconnect/foreground backfill (the "open" handler
		// below) bypasses this, so events missed while disconnected aren't lost.
		if (isLocalEcho(ch.path)) return;
		let payload = null;
		try {
			payload = JSON.parse(evt.data);
		} catch {
			/* malformed — dispatchEvent falls back to a blunt invalidate */
		}
		dispatchEvent(ch, payload);
	});

	es.addEventListener("open", () => {
		if (ch.attempts > 0) fanout(ch); // backfill events missed during the gap
		ch.attempts = 0;
	});

	const onFailure = async () => {
		closeEs(ch);
		if (ch.subs.size === 0) return; // nobody listening anymore
		ch.attempts += 1;

		// First failure on an established session → token most likely expired.
		// Refresh once before reconnecting.
		if (ch.attempts === 1) {
			try {
				await refreshAccessToken();
			} catch {
				/* fall through — backoff will retry */
			}
			if (ch.subs.size === 0) return;
		}

		const delay = Math.min(30_000, 1000 * 2 ** (ch.attempts - 1));
		ch.reconnectTimer = setTimeout(() => openChannel(ch), delay);
	};

	es.addEventListener("error", onFailure);
	es.addEventListener("close", onFailure);
}

// Subscribe to a stream, sharing the socket with any other subscriber on the
// same (path, event). Returns an unsubscribe fn. Invalidations are deduped by
// query key, so two screens watching ["tasks"] only refetch it once.
function subscribe(path, event, qc, queryKey, onEvent) {
	const channelKey = `${path}::${event}`;
	let ch = channels.get(channelKey);
	if (!ch) {
		ch = {
			path,
			event,
			subs: new Map(), // serialized queryKey -> { qc, queryKey, onEvent, count }
			es: null,
			attempts: 0,
			reconnectTimer: null,
			flushTimer: null,
			appStateSub: null,
		};
		channels.set(channelKey, ch);

		// Backgrounding silently kills the socket (often with no error/close
		// event), so on return to the foreground: tear down any zombie, backfill,
		// and reconnect.
		ch.appStateSub = AppState.addEventListener("change", (status) => {
			if (status !== "active" || ch.subs.size === 0) return;
			if (ch.reconnectTimer) {
				clearTimeout(ch.reconnectTimer);
				ch.reconnectTimer = null;
			}
			closeEs(ch);
			ch.attempts = 0;
			fanout(ch);
			openChannel(ch);
		});
	}

	const sig = JSON.stringify(queryKey);
	const existing = ch.subs.get(sig);
	if (existing) existing.count += 1;
	else ch.subs.set(sig, { qc, queryKey, onEvent, count: 1 });

	if (!ch.es && !ch.reconnectTimer) openChannel(ch);

	return () => {
		const entry = ch.subs.get(sig);
		if (entry && --entry.count <= 0) ch.subs.delete(sig);
		if (ch.subs.size === 0) {
			if (ch.reconnectTimer) clearTimeout(ch.reconnectTimer);
			if (ch.flushTimer) clearTimeout(ch.flushTimer);
			ch.reconnectTimer = null;
			ch.flushTimer = null;
			closeEs(ch);
			ch.appStateSub?.remove();
			channels.delete(channelKey);
		}
	};
}

// `queryKey` is the broad family key (e.g. ["tasks"]) — the blunt fallback used
// on a reconnect gap. Pass `onEvent(qc, action, id)` to handle live events
// surgically (patch caches in place) instead; it falls back to invalidating
// `queryKey` if it throws. `onEvent` is captured once at subscribe time (its
// queryClient is stable), so it's intentionally not a re-subscribe dependency.
export function useResourceLiveUpdates({
	path,
	event,
	queryClient,
	queryKey,
	onEvent,
}) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: queryKey compared by JSON; onEvent captured once (stable qc)
	useEffect(
		() => subscribe(path, event, queryClient, queryKey, onEvent),
		[queryClient, path, event, JSON.stringify(queryKey)],
	);
}
