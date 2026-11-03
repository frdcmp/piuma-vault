// Words the Inbox shows for Pigeon's values: channels, switches, statuses.

export const CHANNELS = {
	whatsapp: { label: "WhatsApp", tone: "success" },
	instagram: { label: "Instagram", tone: "violet" },
	gmail: { label: "Gmail", tone: "danger" },
	telegram: { label: "Telegram", tone: "info" },
	vault: { label: "Vault", tone: "accent" },
	console: { label: "Console", tone: "muted" },
};

export const channelLabel = (id) => CHANNELS[id]?.label ?? id;
export const channelTone = (id) => CHANNELS[id]?.tone ?? "muted";

// What Pigeon may do on its own: a policy.
export const POLICY_OPTIONS = [
	{ value: "off", label: "Off" },
	{ value: "ask", label: "Ask" },
	{ value: "auto", label: "Auto" },
];

// How a new message reaches the phone.
export const ALERT_OPTIONS = [
	{ value: "all", label: "All" },
	{ value: "smart", label: "Smart" },
	{ value: "quiet", label: "Quiet" },
	{ value: "off", label: "Off" },
];

export const ALERT_HINT = {
	all: "every message rings",
	smart: "rings when it needs you, the rest arrive silently",
	quiet: "everything arrives silently",
	off: "no pushes",
};

// The scope's own value, or "inherit" (follow the person's, then the default).
export const withInherit = (options, inherited) => [
	{ value: "inherit", label: `Default (${inherited})` },
	...options,
];

export const initials = (name) =>
	(name || "?")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase())
		.join("") || "?";

// A message's attachments, as labels: WhatsApp gives kinds ("image"),
// Instagram objects ({ type }).
export const mediaLabels = (media) =>
	(Array.isArray(media) ? media : [])
		.map((m) => (typeof m === "string" ? m : m?.type))
		.filter(Boolean);

// A message's words without the "[image]" lines that stand in for its media
// (the media's own tags say it already).
export const bodyText = (body, media) => {
	const labels = new Set(mediaLabels(media).map((m) => `[${m}]`));
	if (!labels.size || !body) return body;
	return body
		.split("\n")
		.filter((line) => !labels.has(line.trim()))
		.join("\n")
		.trim();
};

// Who wrote a message in a group: the person Pigeon knows, by name or @slug,
// else the name the channel gave, else their number.
export const senderLabel = (item, senders) => {
	const known = senders?.[item.sender];
	return (
		known?.name ||
		(known?.slug ? `@${known.slug}` : null) ||
		item.sender_name ||
		item.sender
	);
};

export const errorText = (e) =>
	e?.response?.data?.error || e?.message || "Something went wrong";
