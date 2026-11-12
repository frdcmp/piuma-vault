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

// A message's attachments, as labels: a file's own ("image", "voice message"),
// what isn't a file in words ("location: …"), an old Instagram one's type.
export const mediaLabels = (media) =>
	(Array.isArray(media) ? media : [])
		.map((m) => (typeof m === "string" ? m : (m?.label ?? m?.type)))
		.filter(Boolean);

// A message's files (kept in the vault's storage): { id, kind, mime, name,
// size, seconds, status, url, thumb_url }.
export const mediaFiles = (media) =>
	(Array.isArray(media) ? media : []).filter((m) => m?.id && m?.kind);

const isLink = (m) =>
	!(m?.id && m?.kind) && typeof m?.payload?.url === "string";

const LINK_NAMES = {
	ig_reel: "Reel",
	share: "Post",
	ig_post: "Post",
	story_mention: "Story",
	reel: "Reel",
};

// What's shared as a link (an Instagram reel, post or story): { url, title,
// name }, opened with a click.
export const mediaLinks = (media) =>
	(Array.isArray(media) ? media : []).filter(isLink).map((m) => ({
		url: m.payload.url,
		title: m.payload.title?.trim() || null,
		name: LINK_NAMES[m.type] ?? "Link",
	}));

// What isn't a file nor a link, in words (a location, a contact, a poll, an
// old message's "image" from before files were kept).
export const mediaWords = (media) =>
	(Array.isArray(media) ? media : [])
		.filter((m) => !(m?.id && m?.kind) && !isLink(m))
		.map((m) => (typeof m === "string" ? m : m?.type))
		.filter(Boolean);

// A message's reactions grouped by emoji: [{ emoji, count, who: [names] }],
// "You" for the user's own. `senders`: handle → { name, slug }.
export const reactionGroups = (reactions, senders) => {
	const groups = new Map();
	for (const [who, r] of Object.entries(reactions ?? {})) {
		if (!r?.emoji) continue;
		const name = r.me
			? "You"
			: senders?.[who]?.name ||
				(senders?.[who]?.slug && `@${senders[who].slug}`) ||
				r.name ||
				who;
		const g = groups.get(r.emoji) ?? { emoji: r.emoji, count: 0, who: [] };
		g.count += 1;
		g.who.push(name);
		groups.set(r.emoji, g);
	}
	return [...groups.values()];
};

export const fileSize = (n) =>
	!n
		? ""
		: n < 1024 * 1024
			? `${Math.max(1, Math.round(n / 1024))} KB`
			: `${(n / 1024 / 1024).toFixed(1)} MB`;

export const duration = (s) =>
	s
		? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`
		: "";

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

// What Pigeon may tell people. "Place · City", or the tool alone when it has
// no levels (a permission, or one use of it in a reply).
export const permissionLabel = (p) =>
	p?.has_levels && p.level_label ? `${p.label} · ${p.level_label}` : p?.label;

// "Place · City (from Friends)": what a reply uses, and where the leave comes from.
export const usesLine = (used) =>
	(used ?? [])
		.map((u) =>
			u.via ? `${permissionLabel(u)} (${u.via})` : permissionLabel(u),
		)
		.join(", ");

// How sure Jev was, 0..1, as "82%".
export const percent = (p) =>
	typeof p === "number" ? `${Math.round(p * 100)}%` : "";

// What each switch value does, for the ⓘ next to a switch.
export const SWITCH_INFO = {
	reply: {
		title: "Pigeon's replies",
		rows: [
			{
				label: "Default",
				text: "Follows the wider setting: the person's own, else the Inbox's default (Settings). The value in brackets is the one in force.",
			},
			{
				label: "Off",
				text: "Pigeon doesn't write replies by itself. You write yours, or press ✍ and it drafts one for you.",
			},
			{
				label: "Ask",
				text: "When a reply is due, Pigeon writes it and leaves it as a card. Nothing goes out until you press Send; you can change it or drop it.",
			},
			{
				label: "Auto",
				text: "Pigeon sends its replies itself and tells you in the chat. A reply it isn't sure of still waits for you as a card, and with Auto switched off in Settings it always asks.",
			},
		],
	},
	alerts: {
		title: "Alerts",
		rows: [
			{
				label: "Default",
				text: "Follows the wider setting: the person's own, else the Inbox's default (Settings). The value in brackets is the one in force.",
			},
			{
				label: "All",
				text: "Every message they send rings your phone, and so does every card.",
			},
			{
				label: "Smart",
				text: "Their messages arrive silently; a card (a draft, a question, something waiting on you) rings.",
			},
			{
				label: "Quiet",
				text: "Everything arrives silently: messages and cards are on the phone, without a sound.",
			},
			{
				label: "Off",
				text: "Nothing reaches the phone; it all waits in the Inbox.",
			},
		],
		foot: "Something urgent (someone in trouble, something that can't wait) rings whatever the switch says.",
	},
};
