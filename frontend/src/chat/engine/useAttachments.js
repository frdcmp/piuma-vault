import { useCallback, useMemo, useState } from "react";
import { pvMessage } from "@/admin/components/ui";
import {
	extractFile,
	kindOf,
	MAX_CHARS_PER_TURN,
	SUPPORTED_LABEL,
	turnChars,
} from "@/processing";
import { attachmentMeta } from "@/utils/attachments";
import { uploadChatImage } from "../../api/storage";
import { newMessageId } from "./messageModel";

// Files pasted / dropped / attached for the next turn, as one ordered list of
// chips above the composer. Two kinds share it:
//
//   image — uploaded to the disposable `__temp/chat/` prefix and sent to the
//           model as a URL (the vision path). Gated on `visionEnabled`.
//           { kind:"image", localUrl, url, key, mediaType, w, h }
//   doc   — PDF / spreadsheet / Word / text, EXTRACTED IN THE BROWSER by
//           `@/processing` and sent as text. Never uploaded. Works with every
//           model, vision or not.
//           { kind:"doc", icon, mime, text, chars, tokens, truncated, meta }
//
// Every chip: { id, kind, name, status: "uploading"|"extracting"|"ready"|"error" }.
// A scanned PDF (no text layer) crosses over: its pages are rendered to PNGs
// and re-enter as image chips, so the model gets to look at them instead.
// `convRef` scopes image uploads to the conversation.
export default function useAttachments({ visionEnabled, convRef }) {
	const [pending, setPending] = useState([]);

	const busy = pending.some(
		(p) => p.status === "uploading" || p.status === "extracting",
	);
	const readyImages = useMemo(
		() =>
			pending.filter(
				(p) => p.kind === "image" && p.status === "ready" && p.url,
			),
		[pending],
	);
	const readyDocs = useMemo(
		() =>
			pending.filter((p) => p.kind === "doc" && p.status === "ready" && p.text),
		[pending],
	);

	const removePending = useCallback((id) => {
		setPending((curr) => {
			const hit = curr.find((p) => p.id === id);
			if (hit?.localUrl) URL.revokeObjectURL(hit.localUrl);
			return curr.filter((p) => p.id !== id);
		});
	}, []);

	// Sent (or cancelled) → drop every chip and its object URLs.
	const clearPending = useCallback(() => {
		setPending((curr) => {
			for (const p of curr) if (p.localUrl) URL.revokeObjectURL(p.localUrl);
			return [];
		});
	}, []);

	// Switching to a model that can't see images: drop the image chips (they'd
	// be silently ignored) but KEEP the documents — those are text and work on
	// any model. Returns how many were dropped so the caller can say so.
	const dropImages = useCallback(() => {
		let dropped = 0;
		setPending((curr) => {
			const keep = curr.filter((p) => p.kind !== "image");
			dropped = curr.length - keep.length;
			for (const p of curr) if (p.localUrl) URL.revokeObjectURL(p.localUrl);
			return keep;
		});
		return dropped;
	}, []);

	const addImageFile = useCallback(
		(file) => {
			if (!file?.type?.startsWith("image/")) return false;
			if (!visionEnabled) {
				pvMessage.info(
					"This model can't read images — switch to a vision model first.",
				);
				return false;
			}
			const id = newMessageId();
			const localUrl = URL.createObjectURL(file);
			const probe = new Image();
			probe.onload = () =>
				setPending((curr) =>
					curr.map((p) =>
						p.id === id
							? { ...p, w: probe.naturalWidth, h: probe.naturalHeight }
							: p,
					),
				);
			probe.src = localUrl;
			setPending((curr) => [
				...curr,
				{
					id,
					kind: "image",
					localUrl,
					url: null,
					key: null,
					mediaType: file.type || "image/png",
					name: file.name || "image.png",
					w: 0,
					h: 0,
					status: "uploading",
				},
			]);
			uploadChatImage({ file, conversationId: convRef.current })
				.then(({ key, publicUrl, media_type }) =>
					setPending((curr) =>
						curr.map((p) =>
							p.id === id
								? {
										...p,
										url: publicUrl,
										key,
										mediaType: media_type || p.mediaType,
										status: "ready",
									}
								: p,
						),
					),
				)
				.catch(() => {
					pvMessage.error("Image upload failed");
					removePending(id);
				});
			return true;
		},
		[visionEnabled, convRef, removePending],
	);

	const addDocFile = useCallback(
		(file) => {
			const id = newMessageId();
			const { icon } = attachmentMeta(file.name || "");
			setPending((curr) => [
				...curr,
				{
					id,
					kind: "doc",
					icon,
					name: file.name || "document",
					mime: file.type || "",
					text: "",
					chars: 0,
					tokens: 0,
					truncated: false,
					status: "extracting",
				},
			]);
			extractFile(file)
				.then((res) => {
					// Scanned PDF → pages come back as images; swap the doc chip for
					// them so the user sees what the model will actually see.
					if (res.images?.length) {
						removePending(id);
						if (!visionEnabled) {
							pvMessage.info(
								`${file.name} is a scanned PDF with no text layer — switch to a vision model to read it as images.`,
							);
							return;
						}
						for (const img of res.images) addImageFile(img);
						if (res.meta?.truncatedPages)
							pvMessage.info(
								`Only the first ${res.meta.rendered} of ${res.meta.pages} pages of ${file.name} were attached.`,
							);
						return;
					}
					setPending((curr) => {
						// Per-turn budget: refuse rather than silently clip a second file.
						const others = curr.filter((p) => p.id !== id);
						if (turnChars(others) + res.chars > MAX_CHARS_PER_TURN) {
							pvMessage.error(
								`${file.name} would push this message past the attachment limit — send what's staged first, or attach a smaller excerpt.`,
							);
							return others;
						}
						return curr.map((p) =>
							p.id === id
								? {
										...p,
										text: res.text,
										chars: res.chars,
										tokens: res.tokens,
										truncated: res.truncated,
										mime: res.mime || p.mime,
										meta: res.meta,
										status: "ready",
									}
								: p,
						);
					});
				})
				.catch((err) => {
					pvMessage.error(err?.message || `Couldn't read ${file.name}`);
					removePending(id);
				});
			return true;
		},
		[visionEnabled, addImageFile, removePending],
	);

	// Route any file to the right path. Returns true when it was taken.
	const addFile = useCallback(
		(file) => {
			if (!file) return false;
			const kind = kindOf(file);
			if (kind === "image") return addImageFile(file);
			if (kind) return addDocFile(file);
			pvMessage.info(
				`Can't read ${file.name || "that file"}. Supported: ${SUPPORTED_LABEL}.`,
			);
			return false;
		},
		[addImageFile, addDocFile],
	);

	// Grab any file items off the clipboard (screenshots, but also a file copied
	// from the desktop).
	const onPaste = useCallback(
		(e) => {
			const items = e.clipboardData?.items || [];
			let handled = false;
			for (const it of items) {
				if (it.kind !== "file") continue;
				const f = it.getAsFile();
				if (f && addFile(f)) handled = true;
			}
			if (handled) e.preventDefault();
		},
		[addFile],
	);

	const onDrop = useCallback(
		(e) => {
			const files = e.dataTransfer?.files;
			if (!files?.length) return;
			e.preventDefault();
			for (const f of files) addFile(f);
		},
		[addFile],
	);

	return {
		pending,
		busy,
		readyImages,
		readyDocs,
		addFile,
		removePending,
		clearPending,
		dropImages,
		onPaste,
		onDrop,
	};
}
