// The strip of staged-image chips above the composer: optimistic local thumbnail
// + name/dimensions, an upload spinner while in flight, a × to remove once ready.
export default function PendingImages({ images, onRemove }) {
	if (!images.length) return null;
	return (
		<div className="chat-image-tags">
			{images.map((img) => (
				<div
					key={img.id}
					className={`chat-image-tag${img.status === "uploading" ? " is-uploading" : ""}${img.status === "error" ? " is-error" : ""}`}
					title={img.name}
				>
					<img
						className="chat-image-tag-thumb"
						src={img.localUrl || img.url}
						alt={img.name}
					/>
					<span className="chat-image-tag-meta">
						<span className="chat-image-tag-name">{img.name}</span>
						{img.w && img.h ? (
							<span className="chat-image-tag-dim">
								{img.w}×{img.h}
							</span>
						) : null}
					</span>
					{img.status === "uploading" ? (
						<span className="chat-image-tag-spin" aria-hidden="true" />
					) : (
						<button
							type="button"
							className="chat-image-tag-remove"
							onClick={() => onRemove(img.id)}
							aria-label={`Remove ${img.name}`}
						>
							×
						</button>
					)}
				</div>
			))}
		</div>
	);
}
