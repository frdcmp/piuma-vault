// Web Push helpers — register the service worker, request permission, and
// subscribe/unsubscribe the browser via the PushManager. The encrypted push
// itself is sent server-side by the notification-worker.

import {
	fetchVapidPublicKey,
	subscribeWebPush,
	unsubscribeWebPush,
} from "../api/notifications";

export const webPushSupported = () =>
	typeof window !== "undefined" &&
	"serviceWorker" in navigator &&
	"PushManager" in window &&
	"Notification" in window;

// VAPID application server keys are base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const output = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
	return output;
}

export async function registerServiceWorker() {
	if (!webPushSupported()) return null;
	return navigator.serviceWorker.register("/sw.js");
}

// Returns "granted" | "denied" | "default" — current Notification permission.
export function notificationPermission() {
	return webPushSupported() ? Notification.permission : "denied";
}

// Returns true if this browser currently has an active push subscription.
export async function isSubscribed() {
	if (!webPushSupported()) return false;
	const reg = await navigator.serviceWorker.ready;
	const sub = await reg.pushManager.getSubscription();
	return !!sub;
}

// Full enable flow: register SW, ask permission, subscribe, persist to backend.
// Throws on permission denial or any step failing.
export async function enableWebPush() {
	if (!webPushSupported()) throw new Error("Web Push is not supported here");

	await registerServiceWorker();
	const permission = await Notification.requestPermission();
	if (permission !== "granted")
		throw new Error("Notification permission denied");

	const vapidKey = await fetchVapidPublicKey();
	const reg = await navigator.serviceWorker.ready;

	let sub = await reg.pushManager.getSubscription();
	if (!sub) {
		sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(vapidKey),
		});
	}

	await subscribeWebPush(sub.toJSON());
	return true;
}

// Unsubscribe locally and remove the subscription from the backend.
export async function disableWebPush() {
	if (!webPushSupported()) return;
	const reg = await navigator.serviceWorker.ready;
	const sub = await reg.pushManager.getSubscription();
	if (sub) {
		const endpoint = sub.endpoint;
		await sub.unsubscribe();
		try {
			await unsubscribeWebPush(endpoint);
		} catch (_e) {
			/* backend prune is best-effort */
		}
	}
}
