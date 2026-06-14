import { useState } from "react";
import { PvModal } from "../../admin/components/ui";
import {
	useBuckets,
	useCreateBucket,
	useDeleteBucket,
	useDeleteTag,
	useTagRegistry,
	useUpdateBucket,
	useUpdateTag,
} from "../../queries";
import { tagColor } from "../../utils/tagColor";
import "./BucketTags.css";

// Commit an inline edit on blur or Enter, without letting Enter bubble up to the
// modal's global "confirm = close" handler.
const onCommitKey = (fn) => (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.blur();
		fn(e);
	}
};

export default function ManageBucketsModal({ onClose }) {
	const { data: buckets = [] } = useBuckets();
	const { data: tags = [] } = useTagRegistry();
	const createBucket = useCreateBucket();
	const updateBucket = useUpdateBucket();
	const deleteBucket = useDeleteBucket();
	const updateTag = useUpdateTag();
	const deleteTag = useDeleteTag();

	const [newBucket, setNewBucket] = useState("");
	const [tagFilter, setTagFilter] = useState("");
	// The bucket pending deletion (drives the confirm popup). null = no prompt.
	const [pendingDelete, setPendingDelete] = useState(null);

	const confirmDeleteBucket = () => {
		if (!pendingDelete || deleteBucket.isPending) return;
		deleteBucket.mutate(pendingDelete.id, {
			onSuccess: () => setPendingDelete(null),
		});
	};

	const shownTags = tagFilter.trim()
		? tags.filter((t) => t.name.includes(tagFilter.trim().toLowerCase()))
		: tags;

	const addBucket = () => {
		const name = newBucket.trim();
		if (!name) return;
		createBucket.mutate({ name }, { onSuccess: () => setNewBucket("") });
	};

	const renameBucket = (b, value) => {
		const name = value.trim();
		if (!name || name === b.name) return;
		updateBucket.mutate({ id: b.id, name });
	};

	const renameTag = (t, value) => {
		const name = value.trim().toLowerCase();
		if (!name || name === t.name) return;
		updateTag.mutate({ id: t.id, name });
	};

	return (
		<PvModal
			open
			title="Manage buckets & tags"
			confirmText="Done"
			// While the delete-confirm popup is up, drop this modal's Enter→confirm
			// so a keystroke confirms the delete (its own popup) without also
			// closing the manager underneath.
			onConfirm={pendingDelete ? undefined : onClose}
			onCancel={onClose}
			className="mbm"
		>
			<div className="mbm-body">
				<section className="mbm-section">
					<h4 className="mbm-title">Buckets</h4>
					<div className="mbm-add">
						<input
							value={newBucket}
							onChange={(e) => setNewBucket(e.target.value)}
							onKeyDown={onCommitKey(addBucket)}
							placeholder="New bucket name…"
						/>
						<button type="button" className="mbm-btn" onClick={addBucket}>
							+ add
						</button>
					</div>
					<ul className="mbm-list">
						{buckets.map((b) => (
							<li key={b.id} className="mbm-row">
								<input
									type="color"
									className="mbm-color"
									value={b.color || "#5cd0a9"}
									onChange={(e) =>
										updateBucket.mutate({ id: b.id, color: e.target.value })
									}
									aria-label={`${b.name} colour`}
								/>
								<input
									className="mbm-name"
									defaultValue={b.name}
									onBlur={(e) => renameBucket(b, e.target.value)}
									onKeyDown={onCommitKey(() => {})}
								/>
								<button
									type="button"
									className="mbm-del"
									onClick={() => setPendingDelete(b)}
									aria-label={`Delete ${b.name}`}
									title="Delete bucket (its tasks fall back to no bucket)"
								>
									{deleteBucket.isPending && deleteBucket.variables === b.id ? (
										<span className="mbm-spin" aria-hidden="true" />
									) : (
										"✕"
									)}
								</button>
							</li>
						))}
						{buckets.length === 0 ? (
							<li className="mbm-empty">No buckets yet.</li>
						) : null}
					</ul>
				</section>

				<section className="mbm-section">
					<h4 className="mbm-title">Tags</h4>
					<input
						className="mbm-search"
						value={tagFilter}
						onChange={(e) => setTagFilter(e.target.value)}
						placeholder="Filter tags…"
					/>
					<ul className="mbm-list mbm-tags">
						{shownTags.map((t) => (
							<li key={t.id} className="mbm-row">
								<span
									className="mbm-dot"
									style={{ background: t.color || tagColor(t.name) }}
									aria-hidden="true"
								/>
								<input
									className="mbm-name"
									defaultValue={t.name}
									onBlur={(e) => renameTag(t, e.target.value)}
									onKeyDown={onCommitKey(() => {})}
								/>
								<button
									type="button"
									className="mbm-del"
									onClick={() => deleteTag.mutate(t.id)}
									aria-label={`Delete #${t.name}`}
									title="Remove tag from the registry"
								>
									✕
								</button>
							</li>
						))}
						{shownTags.length === 0 ? (
							<li className="mbm-empty">
								{tags.length === 0 ? "No tags yet." : "No matching tags."}
							</li>
						) : null}
					</ul>
					<p className="mbm-hint">
						Renaming a tag updates it everywhere it's used (tasks, recurring,
						events). Tags are flat labels — buckets group tasks, not tags.
					</p>
				</section>
			</div>

			{pendingDelete ? (
				<PvModal
					open
					title="Delete bucket"
					danger
					confirmText={
						deleteBucket.isPending ? (
							<span className="mbm-confirm-busy">
								<span className="mbm-spin" aria-hidden="true" /> Deleting…
							</span>
						) : (
							"Delete"
						)
					}
					cancelText="Cancel"
					onConfirm={confirmDeleteBucket}
					onCancel={() => {
						if (!deleteBucket.isPending) setPendingDelete(null);
					}}
				>
					<p className="mbm-confirm-text">
						Delete the bucket <strong>{pendingDelete.name}</strong>? Its tasks
						aren't deleted — they fall back to no bucket.
					</p>
				</PvModal>
			) : null}
		</PvModal>
	);
}
