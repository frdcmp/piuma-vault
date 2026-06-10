import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef } from "react";
import { AppState, View } from "react-native";
import { useScreenLockSettings } from "../queries/screenLockQuery";
import { useAuthStore } from "../stores/authStore";
import { useScreenLockStore } from "../stores/screenLockStore";
import ScreenLockOverlay from "./ScreenLockOverlay";

// Persisted timestamp of the user's last interaction, so "away time" survives an
// app kill and we can decide on cold start whether to lock.
const LAST_ACTIVE_KEY = "vault.screenlock.lastActiveAt";
const PERSIST_EVERY_MS = 15_000;

/**
 * Idle/app lock. Wraps the whole app. It locks purely on inactivity, using the
 * timeout configured on the web admin:
 *   • on cold start or returning from background — only if the app was idle/away
 *     longer than the timeout (a quick reopen does NOT ask for the PIN),
 *   • after the timeout of no touch while in the foreground.
 * Unlock via the 6-digit PIN (verified server-side) or biometrics.
 */
export default function ScreenLockGate({ children }) {
	const token = useAuthStore((s) => s.token);
	const { data: settings } = useScreenLockSettings({ enabled: !!token });
	const enabled = !!token && !!settings?.enabled;
	const timeoutMs = (settings?.timeout_seconds || 300) * 1000;

	const locked = useScreenLockStore((s) => s.locked);
	const lock = useScreenLockStore((s) => s.lock);
	const unlock = useScreenLockStore((s) => s.unlock);

	const lastActivity = useRef(Date.now());
	const idleTimer = useRef(null);
	const coldStartChecked = useRef(false);

	const persistActivity = useCallback(() => {
		AsyncStorage.setItem(LAST_ACTIVE_KEY, String(lastActivity.current)).catch(
			() => {},
		);
	}, []);

	const clearIdle = useCallback(() => {
		if (idleTimer.current) {
			clearTimeout(idleTimer.current);
			idleTimer.current = null;
		}
	}, []);

	const armIdle = useCallback(() => {
		clearIdle();
		if (enabled) idleTimer.current = setTimeout(() => lock(), timeoutMs);
	}, [clearIdle, enabled, timeoutMs, lock]);

	// Cold start: lock only if the app was idle/away longer than the timeout.
	useEffect(() => {
		if (!enabled || coldStartChecked.current) return;
		coldStartChecked.current = true;
		(async () => {
			try {
				const raw = await AsyncStorage.getItem(LAST_ACTIVE_KEY);
				const last = raw ? Number(raw) : null;
				if (last && Date.now() - last >= timeoutMs) lock();
			} catch {
				/* ignore */
			}
		})();
	}, [enabled, timeoutMs, lock]);

	// Drop a stale lock if the feature is off or the session ended (logout).
	useEffect(() => {
		if (locked && !enabled) unlock();
	}, [locked, enabled, unlock]);

	// Foreground idle timer + periodic persistence of last activity. Entering the
	// unlocked state also resets the clock (covers a fresh unlock).
	useEffect(() => {
		if (!enabled || locked) {
			clearIdle();
			return;
		}
		lastActivity.current = Date.now();
		persistActivity();
		armIdle();
		const persist = setInterval(persistActivity, PERSIST_EVERY_MS);
		return () => {
			clearIdle();
			clearInterval(persist);
		};
	}, [enabled, locked, armIdle, clearIdle, persistActivity]);

	// Background → record the leaving time; foreground → lock if away too long.
	useEffect(() => {
		const sub = AppState.addEventListener("change", (status) => {
			if (!enabled) return;
			if (status === "active") {
				AsyncStorage.getItem(LAST_ACTIVE_KEY)
					.then((raw) => {
						const last = raw ? Number(raw) : null;
						if (last && Date.now() - last >= timeoutMs) lock();
						else if (!locked) {
							lastActivity.current = Date.now();
							armIdle();
						}
					})
					.catch(() => {});
			} else {
				persistActivity();
				clearIdle();
			}
		});
		return () => sub.remove();
	}, [enabled, timeoutMs, locked, lock, armIdle, clearIdle, persistActivity]);

	// onTouchStart bubbles without capturing, so children stay interactive.
	const onTouch = () => {
		if (enabled && !locked) {
			lastActivity.current = Date.now();
			armIdle();
		}
	};

	return (
		<View style={{ flex: 1 }} onTouchStart={onTouch}>
			{children}
			{enabled && locked ? <ScreenLockOverlay /> : null}
		</View>
	);
}
