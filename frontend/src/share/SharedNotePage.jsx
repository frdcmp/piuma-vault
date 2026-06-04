import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useParams, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { fetchSharedNote } from "../api/shares";
import {
	attachmentMeta,
	fileNameFromUrl,
	isAttachmentUrl,
	widthFromUrl,
} from "../utils/attachments";
import "./SharedNotePage.css";

// Render note attachments richly: images inline, every other uploaded file as
// a download/open box. Non-attachment links/images fall through to defaults.
const markdownComponents = {
	a({ href, children, ...props }) {
		if (isAttachmentUrl(href)) {
			const meta = attachmentMeta(href);
			const text = Array.isArray(children) ? children.join("") : children;
			const label =
				(typeof text === "string" && text.trim()) || fileNameFromUrl(href);
			if (meta.category === "video") {
				return (
					<video
						className="shared-note-video"
						src={href}
						controls
						preload="metadata"
					>
						<track kind="captions" />
					</video>
				);
			}
			if (meta.category === "audio") {
				// biome-ignore lint/a11y/useMediaCaption: user-uploaded audio has no caption track
				return (
					<audio
						className="shared-note-audio"
						src={href}
						controls
						preload="metadata"
					/>
				);
			}
			if (meta.category === "pdf") {
				return <iframe className="shared-note-pdf" src={href} title={label} />;
			}
			return (
				<a
					className="attachment-box"
					href={href}
					target="_blank"
					rel="noopener noreferrer"
				>
					<span className="attachment-box-icon">{meta.icon}</span>
					<span className="attachment-box-info">
						<span className="attachment-box-name">{label}</span>
						<span className="attachment-box-hint">{meta.category} · open</span>
					</span>
				</a>
			);
		}
		return (
			<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
				{children}
			</a>
		);
	},
	img({ src, alt }) {
		const w = widthFromUrl(src);
		return (
			<img
				className="shared-note-img"
				src={src}
				alt={alt || ""}
				loading="lazy"
				style={w ? { width: w } : undefined}
			/>
		);
	},
};

export default function SharedNotePage() {
	const { slug } = useParams();
	const [searchParams] = useSearchParams();
	const urlPwd = searchParams.get("pwd") || "";

	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [needsPassword, setNeedsPassword] = useState(false);
	const [pwdInput, setPwdInput] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const load = useCallback(
		async (pwd) => {
			setLoading(true);
			setError(null);
			try {
				const result = await fetchSharedNote(slug, pwd);
				setData(result);
				setNeedsPassword(false);
			} catch (err) {
				if (err.status === 401) {
					setNeedsPassword(true);
					setError(pwd ? "Wrong password." : null);
				} else if (err.status === 404) {
					setError("This share link doesn't exist.");
				} else if (err.status === 403) {
					setError(err.message || "This share link is no longer active.");
				} else {
					setError(err.message || "Failed to load shared note.");
				}
			} finally {
				setLoading(false);
				setSubmitting(false);
			}
		},
		[slug],
	);

	useEffect(() => {
		load(urlPwd || undefined);
	}, [load, urlPwd]);

	const title = data?.note?.title;
	useEffect(() => {
		const prev = document.title;
		if (title) document.title = `${title} — vault.example.com`;
		return () => {
			document.title = prev;
		};
	}, [title]);

	const updatedAt = useMemo(() => {
		const v = data?.note?.updated_at;
		if (!v) return null;
		try {
			return new Date(v).toLocaleString();
		} catch {
			return null;
		}
	}, [data]);

	const handlePasswordSubmit = (e) => {
		e.preventDefault();
		if (!pwdInput.trim()) return;
		setSubmitting(true);
		load(pwdInput.trim());
	};

	if (loading && !needsPassword) {
		return (
			<div className="shared-note-root">
				<div className="shared-note-card">
					<div className="shared-note-loading">Loading…</div>
				</div>
			</div>
		);
	}

	if (needsPassword) {
		return (
			<div className="shared-note-root">
				<div className="shared-note-card">
					<h1 className="shared-note-title">Password required</h1>
					<p className="shared-note-sub">
						This note is protected. Enter the password to view it.
					</p>
					<form
						onSubmit={handlePasswordSubmit}
						className="shared-note-pwd-form"
					>
						<input
							type="password"
							autoFocus
							value={pwdInput}
							onChange={(e) => setPwdInput(e.target.value)}
							placeholder="Password"
							className="shared-note-pwd-input"
						/>
						<button
							type="submit"
							className="shared-note-pwd-btn"
							disabled={submitting}
						>
							{submitting ? "…" : "Unlock"}
						</button>
					</form>
					{error ? <div className="shared-note-error">{error}</div> : null}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="shared-note-root">
				<div className="shared-note-card">
					<h1 className="shared-note-title">Unavailable</h1>
					<p className="shared-note-error">{error}</p>
				</div>
			</div>
		);
	}

	if (!data?.note) return null;

	return (
		<div className="shared-note-root">
			<article className="shared-note-card">
				<header className="shared-note-header">
					<h1 className="shared-note-title">{data.note.title || "Untitled"}</h1>
					<div className="shared-note-meta">
						{data.note.folder ? (
							<span className="shared-note-folder">{data.note.folder}</span>
						) : null}
						{updatedAt ? <span>Updated {updatedAt}</span> : null}
						{data.share?.access_level ? (
							<span className="shared-note-access">
								{data.share.access_level}
							</span>
						) : null}
					</div>
					{data.note.tags?.length ? (
						<div className="shared-note-tags">
							{data.note.tags.map((t) => (
								<span key={t} className="shared-note-tag">
									#{t}
								</span>
							))}
						</div>
					) : null}
				</header>
				<div className="shared-note-body">
					<ReactMarkdown
						components={markdownComponents}
						remarkPlugins={[remarkGfm]}
					>
						{data.note.content || ""}
					</ReactMarkdown>
				</div>
			</article>
		</div>
	);
}
