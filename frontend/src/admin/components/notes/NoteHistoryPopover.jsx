import { useEffect, useRef, useState } from "react";
import { PvButton, PvIconButton, pvConfirm, pvMessage } from "@/ui";
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
	// The confirm dialog portals outside this subtree; while it's up, clicks in
	// it must not count as "outside" and close the popover.
	const confirmingRef = useRef(false);

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
			if (confirmingRef.current) return;
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

	const handleRestore = async (versionId) => {
		confirmingRef.current = true;
		const ok = await pvConfirm({
			title: "Restore this version?",
			content: "The current state is saved to history first, so you can undo.",
			okText: "Restore",
		});
		confirmingRef.current = false;
		if (!ok) return;
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
			<PvIconButton
				icon="🕘"
				label="Version history"
				onClick={() => setOpen((o) => !o)}
				aria-haspopup="dialog"
				aria-expanded={open}
			/>
			{open && (
				<div className="note-history-pop">
					<div className="note-history-head">
						<span>History</span>
						<PvIconButton
							size="sm"
							variant="ghost"
							icon="×"
							label="Close history"
							onClick={() => setOpen(false)}
						/>
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
								<PvButton
									size="sm"
									icon="◀"
									onClick={() => setSelectedId(null)}
								>
									Back
								</PvButton>
								<PvButton
									size="sm"
									variant="accent"
									icon="⟲"
									loading={restoreMutation.isPending}
									disabled={restoreMutation.isPending}
									onClick={() => handleRestore(selectedId)}
								>
									Restore
								</PvButton>
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
