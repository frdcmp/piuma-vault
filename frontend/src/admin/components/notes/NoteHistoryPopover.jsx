import { useEffect, useRef, useState } from "react";
import { pvMessage } from "@/admin/components/ui";
import {
	useNoteVersion,
	useNoteVersions,
	useRestoreNoteVersion,
} from "../../../queries/notesQuery";
import { formatDateTime, timeAgo } from "../../../utils/dateTime";

// Who made the change — from the transaction-local source the backend trigger
// records. Unattributed rows (older data, unexpected paths) fall back to "Edit".
const SOURCE_LABELS = {
	user: "You",
	agent: "AI agent",
	share: "Share link",
	recorder: "Recorder",
	restore: "Restore",
};

function sourceLabel(source) {
	return SOURCE_LABELS[source] ?? "Edit";
}

function sizeLabel(chars) {
	if (chars == null) return "";
	if (chars < 1000) return `${chars} ch`;
	return `${(chars / 1000).toFixed(1)}k ch`;
}

// Version history popover: list of snapshots (newest first), click one to
// preview its markdown, restore with one click. Restoring is undoable — the
// backend snapshots the current state before overwriting it.
export default function NoteHistoryPopover({ noteId }) {
	const [open, setOpen] = useState(false);
	const [selectedId, setSelectedId] = useState(null);
	const popoverRef = useRef(null);

	const { data, isLoading } = useNoteVersions(noteId, { enabled: open });
	const versions = data?.data ?? [];

	const { data: selected, isLoading: previewLoading } = useNoteVersion(
		noteId,
		selectedId,
		{ enabled: open && selectedId != null },
	);
	const restoreMutation = useRestoreNoteVersion();

	useEffect(() => {
		if (!open) return;
		const handleClickOutside = (event) => {
			if (popoverRef.current && !popoverRef.current.contains(event.target)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open]);

	useEffect(() => {
		if (!open) setSelectedId(null);
	}, [open]);

	const handleRestore = (versionId) => {
		if (
			!window.confirm(
				"Restore this version? The current state is saved to history first, so you can undo.",
			)
		)
			return;
		restoreMutation.mutate(
			{ id: noteId, versionId },
			{
				onSuccess: () => {
					pvMessage.success("Version restored");
					setSelectedId(null);
				},
				onError: (err) => {
					pvMessage.error(
						err?.response?.data?.error ?? "Failed to restore version",
					);
				},
			},
		);
	};

	if (!noteId) return null;

	return (
		<span className="note-search-anchor" ref={popoverRef}>
			<button
				type="button"
				className="note-ctl-btn"
				onClick={() => setOpen((o) => !o)}
				title="Version history"
				aria-label="Version history"
				aria-haspopup="dialog"
				aria-expanded={open}
			>
				🕘
			</button>
			{open && (
				<div className="note-history-pop">
					<div className="note-history-head">
						<span>History</span>
						<button
							type="button"
							className="note-ctl-btn"
							onClick={() => setOpen(false)}
							title="Close history"
							aria-label="Close history"
						>
							×
						</button>
					</div>

					{selectedId == null ? (
						<div className="note-history-list">
							{isLoading ? (
								<div className="note-history-empty">Loading…</div>
							) : versions.length === 0 ? (
								<div className="note-history-empty">
									No previous versions yet. A snapshot is kept every time this
									note changes.
								</div>
							) : (
								versions.map((v) => (
									<button
										type="button"
										key={v.id}
										className="note-history-item"
										onClick={() => setSelectedId(v.id)}
										title={formatDateTime(v.created_at)}
									>
										<span className="note-history-item-when">
											{timeAgo(v.created_at)}
										</span>
										<span
											className={`note-history-badge src-${v.source ?? "unknown"}`}
										>
											{sourceLabel(v.source)}
										</span>
										<span className="note-history-item-meta">
											{v.title} · {sizeLabel(v.content_chars)}
										</span>
									</button>
								))
							)}
						</div>
					) : (
						<div className="note-history-preview">
							<div className="note-history-preview-bar">
								<button
									type="button"
									className="pixel-btn"
									onClick={() => setSelectedId(null)}
								>
									◀ Back
								</button>
								<button
									type="button"
									className="pixel-btn"
									disabled={restoreMutation.isPending}
									onClick={() => handleRestore(selectedId)}
								>
									{restoreMutation.isPending ? "Restoring…" : "⟲ Restore"}
								</button>
							</div>
							{previewLoading || !selected ? (
								<div className="note-history-empty">Loading…</div>
							) : (
								<>
									<div className="note-history-preview-meta">
										<strong>{selected.title}</strong>
										<span>
											{formatDateTime(selected.created_at)} ·{" "}
											{sourceLabel(selected.source)} · {selected.folder || "/"}
										</span>
									</div>
									<pre className="note-history-preview-body">
										{selected.content}
									</pre>
								</>
							)}
						</div>
					)}
				</div>
			)}
		</span>
	);
}
