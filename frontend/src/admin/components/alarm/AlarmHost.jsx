import { Button, Dropdown, Modal, Space } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUpcomingAlarms, useUserMe } from "../../../queries";
import { startAlarm, stopAlarm } from "../../../utils/alarmSound";
import { formatDateTime } from "../../../utils/dateTime";
import { formatOffset } from "../AlertsField";

// If an alert's fire_at is already in the past by more than this, don't ring
// (the OS notification covered it) — but a fire within this window when the tab
// just opened still rings, so you don't miss something by seconds.
const RING_GRACE_MS = 2 * 60 * 1000;
const SNOOZE_OPTIONS = [5, 10, 15];

// Survives reloads within a session so a dismissed alarm doesn't ring again.
const dismissedKey = "vault.alarm.dismissed";
function loadDismissed() {
	try {
		return new Set(JSON.parse(sessionStorage.getItem(dismissedKey) || "[]"));
	} catch {
		return new Set();
	}
}
function persistDismissed(set) {
	try {
		sessionStorage.setItem(dismissedKey, JSON.stringify([...set]));
	} catch {
		/* sessionStorage may be unavailable */
	}
}

/**
 * Drives the loud, must-dismiss in-app alarm while the vault is open. Reads the
 * server-materialized upcoming alerts (recurrence/all-day/DST already resolved)
 * and arms a timer per alert; when one fires it rings and shows a blocking modal
 * with Dismiss / Snooze. Mount once near the app root. The OS notification /
 * Web Push covers the closed-tab case; this is the in-app escalation.
 */
export default function AlarmHost() {
	const { data: me } = useUserMe();
	const { data: alarms } = useUpcomingAlarms({ enabled: !!me });

	const [active, setActive] = useState(null);
	const activeRef = useRef(null); // mirrors `active` for synchronous decisions
	const pendingRef = useRef([]); // queued alarms when one is already ringing
	const timersRef = useRef(new Map()); // id -> timeout (server alerts)
	const snoozeTimersRef = useRef(new Map()); // synthetic snooze timers
	const ringingRef = useRef(new Set()); // ids currently ringing/queued
	const dismissedRef = useRef(loadDismissed());

	const show = useCallback((alarm) => {
		activeRef.current = alarm;
		setActive(alarm);
	}, []);

	// Side-effect-free outside of setState so StrictMode double-invokes are safe.
	const trigger = useCallback(
		(alarm) => {
			if (ringingRef.current.has(alarm.id)) return;
			ringingRef.current.add(alarm.id);
			if (activeRef.current) pendingRef.current.push(alarm);
			else show(alarm);
		},
		[show],
	);

	// Arm a timer for each not-yet-handled upcoming alert.
	useEffect(() => {
		if (!Array.isArray(alarms)) return;
		const now = Date.now();
		const liveIds = new Set();

		for (const a of alarms) {
			liveIds.add(a.id);
			if (
				dismissedRef.current.has(a.id) ||
				ringingRef.current.has(a.id) ||
				timersRef.current.has(a.id)
			)
				continue;

			const delay = new Date(a.fire_at).getTime() - now;
			if (delay <= 0) {
				if (delay > -RING_GRACE_MS) trigger(a);
				continue;
			}
			const tid = setTimeout(() => {
				timersRef.current.delete(a.id);
				trigger(a);
			}, delay);
			timersRef.current.set(a.id, tid);
		}

		// Drop timers for alerts that vanished (deleted/edited away).
		for (const [id, tid] of timersRef.current) {
			if (!liveIds.has(id)) {
				clearTimeout(tid);
				timersRef.current.delete(id);
			}
		}
	}, [alarms, trigger]);

	// Ring while an alarm is active; silence otherwise.
	useEffect(() => {
		if (active) startAlarm();
		else stopAlarm();
		return () => stopAlarm();
	}, [active]);

	// Clear everything on unmount.
	useEffect(() => {
		const timers = timersRef.current;
		const snoozes = snoozeTimersRef.current;
		return () => {
			for (const t of timers.values()) clearTimeout(t);
			for (const t of snoozes.values()) clearTimeout(t);
			stopAlarm();
		};
	}, []);

	const advance = useCallback(() => {
		const next = pendingRef.current.shift() || null;
		activeRef.current = next;
		setActive(next);
	}, []);

	const handleDismiss = useCallback(() => {
		if (!active) return;
		dismissedRef.current.add(active.id);
		persistDismissed(dismissedRef.current);
		ringingRef.current.delete(active.id);
		advance();
	}, [active, advance]);

	const handleSnooze = useCallback(
		(minutes) => {
			if (!active) return;
			const base = active;
			// Don't let the poller re-arm the original while it's snoozed.
			dismissedRef.current.add(base.id);
			persistDismissed(dismissedRef.current);
			ringingRef.current.delete(base.id);

			const snoozeId = `${base.id}:snooze:${Date.now()}`;
			const tid = setTimeout(
				() => {
					snoozeTimersRef.current.delete(snoozeId);
					trigger({ ...base, id: snoozeId, snoozed: true });
				},
				minutes * 60 * 1000,
			);
			snoozeTimersRef.current.set(snoozeId, tid);
			advance();
		},
		[active, advance, trigger],
	);

	if (!active) return null;

	const { time } = formatDateTime(active.fire_at);
	const kind =
		active.source_type === "event"
			? "Event"
			: active.source_type === "recurring"
				? "Recurring task"
				: "Task";

	return (
		<Modal
			open
			closable={false}
			maskClosable={false}
			keyboard={false}
			centered
			title={`🔔 ${kind} reminder`}
			footer={
				<Space>
					<Dropdown
						menu={{
							items: SNOOZE_OPTIONS.map((m) => ({
								key: m,
								label: `${m} min`,
								onClick: () => handleSnooze(m),
							})),
						}}
					>
						<Button>Snooze</Button>
					</Dropdown>
					<Button type="primary" danger onClick={handleDismiss}>
						Dismiss
					</Button>
				</Space>
			}
		>
			<h2 style={{ margin: "0 0 8px" }}>{active.title}</h2>
			<p style={{ margin: 0, opacity: 0.85 }}>
				{active.offset_minutes > 0
					? `${formatOffset(active.offset_minutes)} — due at ${time}`
					: `Now — ${time}`}
			</p>
			{active.body ? (
				<p style={{ marginTop: 8, opacity: 0.7 }}>{active.body}</p>
			) : null}
		</Modal>
	);
}
