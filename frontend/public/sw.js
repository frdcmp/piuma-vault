/* Piuma Vault service worker — Web Push receiver.
 *
 * Served from the site root (not bundled). It only handles push delivery and
 * notification clicks; it does not cache app assets. */

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	let payload = {};
	try {
		payload = event.data ? event.data.json() : {};
	} catch (_e) {
		payload = {
			title: "Piuma Vault",
			body: event.data ? event.data.text() : "",
		};
	}

	const title = payload.title || "Piuma Vault";
	const options = {
		body: payload.body || "",
		icon: payload.icon || "/icon-192.png",
		badge: payload.badge || "/icon-192.png",
		tag: payload.tag || undefined,
		data: { url: payload.url || "/admin/calendar" },
		renotify: !!payload.tag,
	};

	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = event.notification.data?.url || "/";

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clients) => {
				// Focus an existing tab if one is open, else open a new one.
				for (const client of clients) {
					if ("focus" in client) {
						client.navigate(url);
						return client.focus();
					}
				}
				if (self.clients.openWindow) return self.clients.openWindow(url);
			}),
	);
});
