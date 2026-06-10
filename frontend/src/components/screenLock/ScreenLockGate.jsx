import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useScreenLockSettings, useUserMe } from "../queries";
import useScreenLockStore from "../store/screenLockStore";
import ScreenLockOverlay from "./ScreenLockOverlay";

// Public route prefixes where the lock never applies (no auth / not the vault owner).
const PUBLIC_PREFIXES = [
	"/share/",
	"/s/",
	"/docs",
	"/admin/login",
	"/admin/forgot-password",
	"/admin/verify-email",
];

const ACTIVITY_EVENTS = [
	"mousemove",
	"mousedown",
	"keydown",
	"touchstart",
	"scroll",
	"wheel",
];

const isPublicPath = (pathname) =>
	PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));

/**
 * Drives the idle screen lock. Mount once near the app root (inside the router).
 * When enabled in admin settings and the session has been idle past the
 * configured timeout, it flips the lock on and renders the blocking overlay.
 */
export default function ScreenLockGate() {
	const location = useLocation();
	const { data: me } = useUserMe();
	const authed = !!me;
	const onPublicPath = isPublicPath(location.pathname);

	const { data: settings } = useScreenLockSettings({
		enabled: authed && !onPublicPath,
		staleTime: 60_000,
	});

	const enabled = !!settings?.enabled;
	const timeoutMs = (settings?.timeout_seconds || 300) * 1000;

	const locked = useScreenLockStore((s) => s.locked);
	const lock = useScreenLockStore((s) => s.lock);
	const unlock = useScreenLockStore((s) => s.unlock);
	const lastActivityRef = useRef(Date.now());

	// Clear a stale persisted lock if the feature is off or the session ended.
	useEffect(() => {
		if (locked && (!enabled || !authed)) unlock();
	}, [locked, enabled, authed, unlock]);

	// Idle tracking — only while enabled, authenticated, and on a private route.
	useEffect(() => {
		if (!enabled || !authed || onPublicPath) return;

		lastActivityRef.current = Date.now();
		const onActivity = () => {
			lastActivityRef.current = Date.now();
		};
		for (const ev of ACTIVITY_EVENTS) {
			window.addEventListener(ev, onActivity, { passive: true });
		}

		const check = () => {
			if (Date.now() - lastActivityRef.current >= timeoutMs) {
				lock();
			}
		};
		const interval = setInterval(check, 5_000);
		// Background tabs throttle timers; re-check when the tab regains focus.
		const onVisibility = () => {
			if (document.visibilityState === "visible") check();
		};
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			for (const ev of ACTIVITY_EVENTS) {
				window.removeEventListener(ev, onActivity);
			}
			clearInterval(interval);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [enabled, authed, onPublicPath, timeoutMs, lock]);

	if (!enabled || !authed || onPublicPath || !locked) return null;
	return <ScreenLockOverlay />;
}
