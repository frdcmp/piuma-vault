import {
	AudioOutlined,
	FileOutlined,
	PictureOutlined,
	VideoCameraOutlined,
} from "@ant-design/icons";
import { duration, fileSize } from "./inboxText";

const WHAT = {
	image: "Photo",
	sticker: "Sticker",
	video: "Video",
	voice: "Voice message",
	audio: "Audio",
	document: "File",
};

const ICON = {
	image: <PictureOutlined />,
	sticker: <PictureOutlined />,
	video: <VideoCameraOutlined />,
	voice: <AudioOutlined />,
	audio: <AudioOutlined />,
	document: <FileOutlined />,
};

// A file not (yet) in storage: coming, or no longer to be had.
function Missing({ file }) {
	const what = WHAT[file.kind] ?? "File";
	const why =
		file.status === "pending"
			? `${what} on its way…`
			: file.status === "gone"
				? `${what}: no longer on ${file.connector ?? "the channel"}`
				: `${what}: couldn't be fetched`;
	return (
		<div className="inbox-media-missing">
			{file.thumb_url ? (
				<img src={file.thumb_url} alt="" className="inbox-media-thumb" />
			) : null}
			<span>
				{ICON[file.kind]} {why}
			</span>
		</div>
	);
}

// One file of a message, as WhatsApp shows it: a photo, a video to play, a
// voice message to listen to, a file to open.
function File({ file }) {
	if (file.status !== "stored" || !file.url) return <Missing file={file} />;
	switch (file.kind) {
		case "image":
		case "sticker":
			return (
				<a href={file.url} target="_blank" rel="noreferrer">
					<img
						src={file.url}
						alt={file.name ?? WHAT[file.kind]}
						className={`inbox-media-img${file.kind === "sticker" ? " is-sticker" : ""}`}
						loading="lazy"
					/>
				</a>
			);
		case "video":
			return (
				// biome-ignore lint/a11y/useMediaCaption: their video, as it came: no captions to give
				<video
					className="inbox-media-video"
					src={file.url}
					poster={file.thumb_url}
					controls
					preload="metadata"
				/>
			);
		case "voice":
		case "audio":
			return (
				<div className="inbox-media-audio">
					{/* biome-ignore lint/a11y/useMediaCaption: a voice message, as it came */}
					<audio src={file.url} controls preload="metadata" />
					{file.seconds ? <span>{duration(file.seconds)}</span> : null}
				</div>
			);
		default:
			return (
				<a
					className="inbox-media-file"
					href={file.url}
					target="_blank"
					rel="noreferrer"
					download={file.name ?? undefined}
				>
					{ICON.document}
					<span className="inbox-media-file-name">{file.name ?? "File"}</span>
					<span className="inbox-media-file-size">{fileSize(file.size)}</span>
				</a>
			);
	}
}

// A message's files.
export default function InboxMedia({ files }) {
	if (!files.length) return null;
	return (
		<div className="inbox-media">
			{files.map((f) => (
				<File key={f.id} file={f} />
			))}
		</div>
	);
}
