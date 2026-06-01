import {
	DeleteOutlined,
	ReloadOutlined,
	UndoOutlined,
} from "@ant-design/icons";
import { Button, Modal, message, Space, Table } from "antd";
import {
	useEmptyTrash,
	usePermanentlyDeleteNote,
	useRestoreNote,
	useTrash,
} from "../../../queries";
import { formatDateTime, timeAgo } from "../../../utils/dateTime";
import { PageContent } from "../../components/layout/PageLayout";
import { PvButton, PvPanel } from "../../components/ui";
import "../../vault-pixel.css";
import "./trash.css";

const TrashPage = () => {
	const { data, isLoading, refetch } = useTrash();
	const restoreMutation = useRestoreNote();
	const purgeMutation = usePermanentlyDeleteNote();
	const emptyMutation = useEmptyTrash();

	const notes = data?.data || [];

	const handleRestore = (record) => {
		restoreMutation.mutate(record.id, {
			onSuccess: () => message.success(`Restored "${record.title}"`),
			onError: () => message.error("Failed to restore note"),
		});
	};

	const handlePurge = (record) => {
		Modal.confirm({
			title: "Delete permanently",
			content: `Permanently delete "${record.title}"? Its content and uploaded attachments will be removed for good. This cannot be undone.`,
			okText: "Delete permanently",
			okType: "danger",
			onOk: () => {
				purgeMutation.mutate(record.id, {
					onSuccess: () => message.success("Note permanently deleted"),
					onError: () => message.error("Failed to delete note"),
				});
			},
		});
	};

	const handleEmptyTrash = () => {
		Modal.confirm({
			title: "Empty trash",
			content: `Permanently delete all ${notes.length} note(s) in the trash, including their attachments? This cannot be undone.`,
			okText: "Empty trash",
			okType: "danger",
			onOk: () => {
				emptyMutation.mutate(undefined, {
					onSuccess: (res) =>
						message.success(
							`Trash emptied (${res?.deleted_count ?? 0} note(s) removed)`,
						),
					onError: () => message.error("Failed to empty trash"),
				});
			},
		});
	};

	const columns = [
		{
			title: "Title",
			dataIndex: "title",
			key: "title",
			render: (title) => <span className="vp-trash-title">{title}</span>,
		},
		{
			title: "Folder",
			dataIndex: "folder",
			key: "folder",
			render: (folder) => <code className="vp-keys-code">{folder || "/"}</code>,
		},
		{
			title: "Deleted",
			dataIndex: "deleted_at",
			key: "deleted_at",
			render: (date) => {
				const { date: d, time: t } = formatDateTime(date);
				return <span title={`${d} ${t}`}>{timeAgo(date)}</span>;
			},
			sorter: (a, b) =>
				new Date(a.deleted_at).getTime() - new Date(b.deleted_at).getTime(),
			defaultSortOrder: "descend",
		},
		{
			title: "Actions",
			key: "actions",
			render: (_, record) => (
				<Space>
					<Button
						type="text"
						icon={<UndoOutlined />}
						onClick={() => handleRestore(record)}
						title="Restore"
					>
						Restore
					</Button>
					<Button
						type="text"
						danger
						icon={<DeleteOutlined />}
						onClick={() => handlePurge(record)}
						title="Delete permanently"
					/>
				</Space>
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
						onClick={handleEmptyTrash}
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
				<Table
					className="vp-table"
					columns={columns}
					dataSource={notes}
					rowKey="id"
					loading={isLoading}
					pagination={{ pageSize: 15, showSizeChanger: true }}
					locale={{ emptyText: "Trash is empty" }}
				/>
			</PvPanel>
		</PageContent>
	);
};

export default TrashPage;
