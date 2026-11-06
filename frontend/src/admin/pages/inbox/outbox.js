// What the user is sending, shown in the chat at once (as on the phone): an
// entry per message (text, or one picked file with its caption) until the
// vault has it. status: "sending" | "failed"; progress: 0–1 while a file goes up.

let n = 0;

export const outboxEntry = ({ thread, connector, text = "", file = null }) => ({
	key: `out-${Date.now()}-${n++}`,
	thread,
	connector,
	text: text.trim(),
	file,
	// a photo or video's picture while it goes up
	preview:
		file && /^(image|video)\//.test(file.type)
			? URL.createObjectURL(file)
			: null,
	at: new Date().toISOString(),
	status: "sending",
	progress: file ? 0 : null,
	error: null,
});

// The entry as a message in the chat (its `local` is the entry).
export const localItem = (e) => ({
	id: e.key,
	direction: "out",
	author: "me",
	body: e.text,
	media: [],
	at: e.at,
	connector: e.connector,
	local: e,
});

// The vault's words for a sent file (media::label_of).
const label = (f) =>
	f.type?.startsWith("image/")
		? "image"
		: f.type?.startsWith("video/")
			? "video"
			: f.type?.startsWith("audio/")
				? "audio"
				: `document: ${f.name}`;

// Its message came from the vault (the refetch after a send, or the live
// stream a moment before it): the local one would be a double.
export function arrived(e, items) {
	const since = new Date(e.at) - 60 * 1000;
	const body = e.file
		? e.text
			? `${e.text}\n[${label(e.file)}]`
			: `[${label(e.file)}]`
		: e.text;
	return (items ?? []).some(
		(i) =>
			i.direction === "out" &&
			new Date(i.at) >= since &&
			(i.body === body ||
				(e.file && (i.media ?? []).some((m) => m?.name === e.file.name))),
	);
}
