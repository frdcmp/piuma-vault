// Horizontal strip of open-note tabs above the editor. The active tab is the
// one matching the current route; clicking a tab switches notes, the × closes
// it. A preview (transient) tab renders italic; double-clicking it pins the tab
// permanently. Rendered only on desktop — mobile shows one note at a time.
export default function NoteTabs({ tabs, activeId, onSelect, onClose, onPin }) {
	if (!tabs.length) return null;

	return (
		<div className="note-tabs" role="tablist" aria-label="Open notes">
			{tabs.map((tab) => {
				const active = tab.id === activeId;
				return (
					<div
						key={tab.id}
						className={`note-tab ${active ? "active" : ""} ${
							tab.preview ? "preview" : ""
						}`}
					>
						<button
							type="button"
							className="note-tab-label"
							role="tab"
							aria-selected={active}
							title={tab.preview ? `${tab.title} (preview)` : tab.title}
							onClick={() => onSelect(tab.id)}
							onDoubleClick={() => onPin?.(tab.id)}
							onAuxClick={(e) => {
								// Middle-click closes, matching browser tab behaviour.
								if (e.button === 1) {
									e.preventDefault();
									onClose(tab.id);
								}
							}}
						>
							{tab.title || "Untitled"}
						</button>
						<button
							type="button"
							className="note-tab-close"
							aria-label={`Close ${tab.title || "note"}`}
							title="Close tab"
							onClick={(e) => {
								e.stopPropagation();
								onClose(tab.id);
							}}
						>
							×
						</button>
					</div>
				);
			})}
		</div>
	);
}
