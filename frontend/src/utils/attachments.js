// Shared helpers for note "attachments" — files uploaded to Bunny under the
// public `notes-attachments/` prefix and referenced from note markdown.
//
// Convention: images are embedded as `![name](url)` (rendered inline), every
// other file as `[name](url)` (rendered as a download/open box). A link/image
// is treated as one of our attachments when its URL sits under the
// `notes-attachments/` prefix; the file extension then picks the category/icon.

export const ATTACHMENTS_PREFIX = "notes-attachments/";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|m4v|mkv)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|ogg|aac|flac)$/i;
const PDF_RE = /\.pdf$/i;
const SHEET_RE = /\.(xlsx?|csv|ods)$/i;
const DOC_RE = /\.(docx?|odt|rtf|txt|md|pages)$/i;
const ARCHIVE_RE = /\.(zip|rar|7z|tar|gz|tgz)$/i;

// True when a URL points at one of our uploaded note attachments.
export const isAttachmentUrl = (url) =>
	typeof url === "string" && url.includes(`/${ATTACHMENTS_PREFIX}`);

// Last path segment, query/hash stripped and percent-decoded. Falls back to "file".
export const fileNameFromUrl = (url) => {
	if (typeof url !== "string") return "file";
	const clean = url.split("?")[0].split("#")[0];
	const last = clean.substring(clean.lastIndexOf("/") + 1);
	try {
		return decodeURIComponent(last) || "file";
	} catch {
		return last || "file";
	}
};

export const isImageName = (name = "") => IMAGE_RE.test(name);

// Category + emoji glyph for an attachment, keyed off its filename extension.
export const attachmentMeta = (urlOrName = "") => {
	const name = urlOrName.includes("/") ? fileNameFromUrl(urlOrName) : urlOrName;
	if (IMAGE_RE.test(name)) return { category: "image", icon: "🖼" };
	if (VIDEO_RE.test(name)) return { category: "video", icon: "🎬" };
	if (AUDIO_RE.test(name)) return { category: "audio", icon: "🎵" };
	if (PDF_RE.test(name)) return { category: "pdf", icon: "📕" };
	if (SHEET_RE.test(name)) return { category: "spreadsheet", icon: "📊" };
	if (DOC_RE.test(name)) return { category: "doc", icon: "📄" };
	if (ARCHIVE_RE.test(name)) return { category: "archive", icon: "🗜" };
	return { category: "file", icon: "📎" };
};

// Sanitizes a filename into a URL-safe storage key segment: spaces and other
// awkward characters (parens, brackets, …) collapse to "-", so the resulting
// CDN URL never needs escaping and won't break markdown link syntax. Keeps the
// extension. The original name is still used as the human-facing label.
export const sanitizeKeyName = (name = "upload") => {
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	const safeBase =
		base
			.normalize("NFKD")
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "file";
	const safeExt = ext.replace(/[^A-Za-z0-9.]+/g, "");
	return `${safeBase}${safeExt}`;
};

// Percent-encodes the path segments of a URL (leaving scheme/host/query/hash
// intact) so spaces or parentheses can't break a markdown link destination.
export const encodeAttachmentUrl = (url) => {
	if (typeof url !== "string") return url;
	const m = url.match(/^([a-zA-Z][\w+.-]*:\/\/[^/]+)(\/[^?#]*)?(.*)$/);
	if (!m) return url;
	const [, origin, path = "", tail = ""] = m;
	const encPath = path
		.split("/")
		.map((seg) => {
			try {
				return encodeURIComponent(decodeURIComponent(seg));
			} catch {
				return encodeURIComponent(seg);
			}
		})
		.join("/");
	return `${origin}${encPath}${tail}`;
};

// Markdown snippet to embed an uploaded attachment: inline image for images,
// labelled link (rendered as a box) for everything else. The URL is encoded so
// special characters can't break the link; the label keeps the original name.
export const attachmentMarkdown = (name, url) => {
	const safe = encodeAttachmentUrl(url);
	return isImageName(name) ? `![${name}](${safe})` : `[${name}](${safe})`;
};

// Display width (px) for an image, stored as a `w` query param on its URL.
// Returns null when absent/invalid. Aspect ratio is never stored — only the
// width — so the natural form factor is always preserved at render time.
export const widthFromUrl = (url) => {
	const m = typeof url === "string" && url.match(/[?&]w=(\d+)/);
	const n = m ? Number.parseInt(m[1], 10) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : null;
};

// Returns `url` with the `w` query param set to `w` (or removed when falsy),
// leaving any other query params and the hash intact.
export const withWidth = (url, w) => {
	if (typeof url !== "string") return url;
	const [main, hash = ""] = url.split("#");
	const qIdx = main.indexOf("?");
	const path = qIdx === -1 ? main : main.slice(0, qIdx);
	const query = qIdx === -1 ? "" : main.slice(qIdx + 1);
	const parts = query
		? query.split("&").filter((p) => p && !/^w=/.test(p))
		: [];
	if (w && w > 0) parts.push(`w=${Math.round(w)}`);
	const qs = parts.length ? `?${parts.join("&")}` : "";
	return `${path}${qs}${hash ? `#${hash}` : ""}`;
};
