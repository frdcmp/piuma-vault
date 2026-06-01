import {
	DeleteOutlined,
	ReloadOutlined,
	UndoOutlined,
} from "@ant-design/icons";
import { useState } from "react";
import {
	useEmptyTrash,
	usePermanentlyDeleteNote,
	useRestoreNote,
	useTrash,
} from "../../../queries";
import { formatDateTime, timeAgo } from "../../../utils/dateTime";
import { PageContent } from "../../components/layout/PageLayout";
import {
	PvButton,
	PvModal,
	PvPanel,
	PvTable,
	pvMessage,
} from "../../components/ui";
import "../../vault-pixel.css";
import "./trash.css";

const TrashPage = () => {
	const { data, isLoading, refetch } = useTrash();
	const restoreMutation = useRestoreNote();
	const purgeMutation = usePermanentlyDeleteNote();
	const emptyMutation = useEmptyTrash();

	// Pending confirmations: a note to purge, or the "empty trash" prompt.
	const [pendingPurge, setPendingPurge] = useState(null);
	const [emptyPrompt, setEmptyPrompt] = useState(false);

	const notes = data?.data || [];

	const handleRestore = (record) => {
		restoreMutation.mutate(record.id, {
			onSuccess: () => pvMessage.success(`Restored "${record.title}"`),
			onError: () => pvMessage.error("Failed to restore note"),
		});
	};

	const confirmPurge = () => {
		const record = pendingPurge;
		setPendingPurge(null);
		if (!record) return;
		purgeMutation.mutate(record.id, {
			onSuccess: () => pvMessage.success("Note permanently deleted"),
			onError: () => pvMessage.error("Failed to delete note"),
		});
	};

	const confirmEmpty = () => {
		setEmptyPrompt(false);
		emptyMutation.mutate(undefined, {
			onSuccess: (res) =>
				pvMessage.success(
					`Trash emptied (${res?.deleted_count ?? 0} note(s) removed)`,
				),
			onError: () => pvMessage.error("Failed to empty trash"),
		});
	};

	const columns = [
		{
			key: "title",
			title: "Title",
			dataIndex: "title",
			render: (title) => <span className="vp-trash-title">{title}</span>,
		},
		{
			key: "folder",
			title: "Folder",
			dataIndex: "folder",
			render: (folder) => (
				<code className="vp-trash-folder">{folder || "/"}</code>
			),
		},
		{
			key: "deleted_at",
			title: "Deleted",
			dataIndex: "deleted_at",
			render: (date) => {
				const { date: d, time: t } = formatDateTime(date);
				return <span title={`${d} ${t}`}>{timeAgo(date)}</span>;
			},
		},
		{
			key: "actions",
			title: "Actions",
			align: "right",
			render: (_v, record) => (
				<div className="vp-trash-actions">
					<PvButton
						size="sm"
						icon={<UndoOutlined />}
						onClick={() => handleRestore(record)}
					>
						Restore
					</PvButton>
					<PvButton
						size="sm"
						variant="danger"
						icon={<DeleteOutlined />}
						onClick={() => setPendingPurge(record)}
						aria-label="Delete permanently"
					/>
				</div>
			),
		},
	];

	return (
		<PageContent>
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">Trash</h1>
					<p className="vp-page-subtitle">
						Deleted notes are kept here until you restore them or empty the
						trash. Nothing is removed automatically.
					</p>
				</div>
				<div className="vp-row vp-row--wrap">
					<PvButton
						variant="danger"
						icon={<DeleteOutlined />}
						onClick={() => setEmptyPrompt(true)}
						disabled={notes.length === 0 || emptyMutation.isPending}
					>
						Empty Trash
					</PvButton>
					<PvButton
						icon={<ReloadOutlined />}
						onClick={() => refetch()}
						disabled={isLoading}
					>
						Refresh
					</PvButton>
				</div>
			</div>

			<PvPanel title="trash.table" noPad className="vp-trash-table-panel">
				<PvTable
					columns={columns}
					data={notes}
					rowKey="id"
					loading={isLoading}
					emptyText="Trash is empty"
				/>
			</PvPanel>

			<PvModal
				open={pendingPurge != null}
				title="Delete Permanently"
				confirmText="Delete Permanently"
				cancelText="Cancel"
				danger
				onConfirm={confirmPurge}
				onCancel={() => setPendingPurge(null)}
			>
				Permanently delete "{pendingPurge?.title}"? Its content and uploaded
				attachments will be removed for good. This cannot be undone.
			</PvModal>

			<PvModal
				open={emptyPrompt}
				title="Empty Trash"
				confirmText="Empty Trash"
				cancelText="Cancel"
				danger
				onConfirm={confirmEmpty}
				onCancel={() => setEmptyPrompt(false)}
			>
				Permanently delete all {notes.length} note(s) in the trash, including
				their attachments? This cannot be undone.
			</PvModal>
		</PageContent>
	);
};

export default TrashPage;
