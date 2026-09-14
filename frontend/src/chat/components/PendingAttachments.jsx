import { HEAVY_TOKENS } from "@/processing";

const fmtTokens = (n) =>
	n >= 1000 ? `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tok` : `~${n} tok`;

// The strip of staged-attachment chips above the composer. Image chips show an
// optimistic local thumbnail + dimensions; document chips show a type glyph +
// the extracted size in tokens (the cost the user is about to commit to every
// later turn — see processing/budget.js), flagged when heavy or truncated. A
// spinner while uploading/extracting, a × to remove once ready.
export default function PendingAttachments({ items, onRemove }) {
	if (!items.length) return null;
	return (
		<div className="chat-image-tags">
			{items.map((it) => {
				const working = it.status === "uploading" || it.status === "extracting";
				const heavy = it.kind === "doc" && it.tokens >= HEAVY_TOKENS;
				const title =
					it.kind === "doc" && it.status === "ready"
						? `${it.name} — ${it.chars.toLocaleString()} chars${it.truncated ? " (truncated to fit)" : ""}${heavy ? ". Large: re-sent on every turn of this chat." : ""}`
						: it.name;
				return (
					<div
						key={it.id}
						className={`chat-image-tag${working ? " is-uploading" : ""}${it.status === "error" ? " is-error" : ""}${heavy ? " is-heavy" : ""}`}
						title={title}
					>
						{it.kind === "image" ? (
							<img
								className="chat-image-tag-thumb"
								src={it.localUrl || it.url}
								alt={it.name}
							/>
						) : (
							<span className="chat-image-tag-icon" aria-hidden="true">
								{it.icon}
							</span>
						)}
						<span className="chat-image-tag-meta">
							<span className="chat-image-tag-name">{it.name}</span>
							{it.kind === "image" && it.w && it.h ? (
								<span className="chat-image-tag-dim">
									{it.w}×{it.h}
								</span>
							) : null}
							{it.kind === "doc" ? (
								<span className="chat-image-tag-dim">
									{it.status === "extracting"
										? "reading…"
										: `${fmtTokens(it.tokens)}${it.truncated ? " · cut" : ""}`}
								</span>
							) : null}
						</span>
						{working ? (
							<span className="chat-image-tag-spin" aria-hidden="true" />
						) : (
							<button
								type="button"
								className="chat-image-tag-remove"
								onClick={() => onRemove(it.id)}
								aria-label={`Remove ${it.name}`}
							>
								×
							</button>
						)}
					</div>
				);
			})}
		</div>
	);
}
