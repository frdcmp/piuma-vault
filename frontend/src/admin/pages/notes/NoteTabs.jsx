import { useState } from "react";

// Horizontal strip of open-note tabs above the editor. The active tab is the
// one matching the current route; clicking a tab switches notes, the × closes
// it. A preview (transient) tab renders italic; double-clicking it pins the tab
// permanently. Tabs can be dragged left/right to reorder (HTML5 DnD, same as
// the file tree). Rendered only on desktop — mobile shows one note at a time.
export default function NoteTabs({
	tabs,
	activeId,
	onSelect,
	onClose,
	onPin,
	onReorder,
}) {
	// id of the tab being dragged, and the tab currently hovered as a drop slot.
	const [dragId, setDragId] = useState(null);
	const [overId, setOverId] = useState(null);

	if (!tabs.length) return null;

	const endDrag = () => {
		setDragId(null);
		setOverId(null);
	};

	return (
		<div className="note-tabs" role="tablist" aria-label="Open notes">
			{tabs.map((tab) => {
				const active = tab.id === activeId;
				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: tab keeps its button semantics; the wrapper only carries drag-to-reorder
					<div
						key={tab.id}
						className={`note-tab ${active ? "active" : ""} ${
							tab.preview ? "preview" : ""
						} ${dragId === tab.id ? "dragging" : ""} ${
							overId === tab.id && dragId !== tab.id ? "drag-over" : ""
						}`}
						draggable={!!onReorder}
						onDragStart={(e) => {
							e.dataTransfer.effectAllowed = "move";
							e.dataTransfer.setData("text/plain", tab.id);
							setDragId(tab.id);
						}}
						onDragOver={(e) => {
							if (!dragId || dragId === tab.id) return;
							e.preventDefault();
							e.dataTransfer.dropEffect = "move";
							if (overId !== tab.id) setOverId(tab.id);
						}}
						onDrop={(e) => {
							e.preventDefault();
							if (dragId && dragId !== tab.id) onReorder?.(dragId, tab.id);
							endDrag();
						}}
						onDragEnd={endDrag}
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
