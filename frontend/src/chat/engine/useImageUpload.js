import { useCallback, useState } from "react";
import { pvMessage } from "@/admin/components/ui";
import { uploadChatImage } from "../../api/storage";
import { newMessageId } from "./messageModel";

// Images pasted / dropped / attached for the next turn. Each pending image:
// { id, localUrl, url, key, mediaType, name, w, h, status: "uploading"|"ready"|"error" }.
// Uploads to the disposable __temp/chat/ prefix, shows an optimistic local
// thumbnail immediately, and swaps in the CDN url when the upload lands. Gated on
// the active model supporting vision. `convRef` scopes the upload to the chat.
export default function useImageUpload({ visionEnabled, convRef }) {
	const [pendingImages, setPendingImages] = useState([]);
	const uploadingImages = pendingImages.some((p) => p.status === "uploading");

	const removePendingImage = useCallback((id) => {
		setPendingImages((curr) => {
			const hit = curr.find((p) => p.id === id);
			if (hit?.localUrl) URL.revokeObjectURL(hit.localUrl);
			return curr.filter((p) => p.id !== id);
		});
	}, []);

	const addImageFile = useCallback(
		(file) => {
			if (!file?.type?.startsWith("image/")) return;
			if (!visionEnabled) {
				pvMessage.info(
					"This model can't read images — switch to a vision model first.",
				);
				return;
			}
			const id = newMessageId();
			const localUrl = URL.createObjectURL(file);
			const probe = new Image();
			probe.onload = () =>
				setPendingImages((curr) =>
					curr.map((p) =>
						p.id === id
							? { ...p, w: probe.naturalWidth, h: probe.naturalHeight }
							: p,
					),
				);
			probe.src = localUrl;
			setPendingImages((curr) => [
				...curr,
				{
					id,
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
					setPendingImages((curr) =>
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
					removePendingImage(id);
				});
		},
		[visionEnabled, convRef, removePendingImage],
	);

	// Grab any image items off the clipboard.
	const onPaste = useCallback(
		(e) => {
			const items = e.clipboardData?.items || [];
			let handled = false;
			for (const it of items) {
				if (it.kind === "file" && it.type.startsWith("image/")) {
					const f = it.getAsFile();
					if (f) {
						addImageFile(f);
						handled = true;
					}
				}
			}
			if (handled) e.preventDefault();
		},
		[addImageFile],
	);

	const onDrop = useCallback(
		(e) => {
			const files = e.dataTransfer?.files;
			if (!files?.length) return;
			let handled = false;
			for (const f of files) {
				if (f.type.startsWith("image/")) {
					addImageFile(f);
					handled = true;
				}
			}
			if (handled) e.preventDefault();
		},
		[addImageFile],
	);

	return {
		pendingImages,
		setPendingImages,
		uploadingImages,
		addImageFile,
		removePendingImage,
		onPaste,
		onDrop,
	};
}
