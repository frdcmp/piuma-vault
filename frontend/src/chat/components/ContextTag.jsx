// One context chip — transient (from an open tab, dimmed; click to lock) or
// locked (pinned, solid; × to unlock). Read-only inside a sent bubble. Only the
// embedded dock uses the interactive form; sent bubbles render it inert.
export default function ContextTag({
	label,
	title,
	locked,
	preview,
	onClick,
	onRemove,
}) {
	const inner = (
		<>
			<span className="chat-context-tag-icon" aria-hidden="true">
				{locked ? "◆" : "◇"}
			</span>
			<span className="chat-context-tag-label">{label}</span>
		</>
	);
	return (
		<span
			className={`chat-context-tag ${locked ? "locked" : "transient"} ${
				!locked && preview ? "preview" : ""
			}`}
			title={title}
		>
			{onClick ? (
				<button
					type="button"
					className="chat-context-tag-main"
					onClick={onClick}
					title={
						locked
							? "Click to open this note"
							: "Click to keep this note in context"
					}
				>
					{inner}
				</button>
			) : (
				<span className="chat-context-tag-main">{inner}</span>
			)}
			{onRemove ? (
				<button
					type="button"
					className="chat-context-tag-x"
					onClick={onRemove}
					aria-label={`Remove ${label} from context`}
				>
					×
				</button>
			) : null}
		</span>
	);
}
