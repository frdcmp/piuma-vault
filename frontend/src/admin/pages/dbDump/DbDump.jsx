import {
	CloudUploadOutlined,
	DatabaseOutlined,
	DeleteOutlined,
	DownloadOutlined,
	ReloadOutlined,
	UndoOutlined,
} from "@ant-design/icons";
import { useState } from "react";
import {
	useCreateDump,
	useDeleteDump,
	useDownloadDump,
	useDumps,
	useRestoreDump,
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
import "./dbDump.css";

// Human-readable file size from a byte count.
const formatSize = (bytes) => {
	if (bytes == null) return "—";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let size = bytes / 1024;
	let i = 0;
	while (size >= 1024 && i < units.length - 1) {
		size /= 1024;
		i++;
	}
	return `${size.toFixed(size >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const DbDump = () => {
	const { data, isLoading, refetch } = useDumps();
	const createMutation = useCreateDump();
	const downloadMutation = useDownloadDump();
	const deleteMutation = useDeleteDump();
	const restoreMutation = useRestoreDump();

	// Pending confirmations.
	const [pendingDelete, setPendingDelete] = useState(null);
	const [pendingRestore, setPendingRestore] = useState(null);
	const [restoreConfirmText, setRestoreConfirmText] = useState("");

	const dumps = data?.dumps || [];

	const handleCreate = () => {
		createMutation.mutate(undefined, {
			onSuccess: (res) =>
				pvMessage.success(
					`Backup created: ${res.filename} (${res.tables} tables, ${res.rows} rows)`,
				),
			onError: (e) =>
				pvMessage.error(
					e?.response?.data?.message || "Failed to create backup",
				),
		});
	};

	const handleDownload = (record) => {
		downloadMutation.mutate(record.key, {
			onSuccess: (res) => {
				// Presigned/CDN URL — trigger the browser download directly.
				const a = document.createElement("a");
				a.href = res.url;
				a.rel = "noopener";
				a.download = res.filename || record.filename;
				document.body.appendChild(a);
				a.click();
				a.remove();
			},
			onError: () => pvMessage.error("Failed to get download link"),
		});
	};

	const confirmDelete = () => {
		const record = pendingDelete;
		setPendingDelete(null);
		if (!record) return;
		deleteMutation.mutate(record.key, {
			onSuccess: () => pvMessage.success(`Deleted ${record.filename}`),
			onError: () => pvMessage.error("Failed to delete backup"),
		});
	};

	const confirmRestore = () => {
		const record = pendingRestore;
		// Hard gate: only proceed when the user typed the exact phrase.
		if (!record || restoreConfirmText.trim() !== "RESTORE") return;
		setPendingRestore(null);
		setRestoreConfirmText("");
		restoreMutation.mutate(record.key, {
			onSuccess: (res) =>
				pvMessage.success(
					`Database restored from ${record.filename} (${res.tables} tables, ${res.rows} rows)`,
				),
			onError: (e) =>
				pvMessage.error(
					e?.response?.data?.message || "Restore failed (changes rolled back)",
				),
		});
	};

	const closeRestore = () => {
		setPendingRestore(null);
		setRestoreConfirmText("");
	};

	const columns = [
		{
			key: "filename",
			title: "Backup",
			dataIndex: "filename",
			render: (filename) => (
				<span className="vp-dump-name">
					<DatabaseOutlined /> {filename}
				</span>
			),
		},
		{
			key: "size",
			title: "Size",
			dataIndex: "size",
			align: "right",
			render: (size) => (
				<code className="vp-dump-size">{formatSize(size)}</code>
			),
		},
		{
			key: "last_modified",
			title: "Created",
			dataIndex: "last_modified",
			render: (date) => {
				if (!date) return "—";
				const { date: d, time: t } = formatDateTime(date);
				return <span title={`${d} ${t}`}>{timeAgo(date)}</span>;
			},
		},
		{
			key: "actions",
			title: "Actions",
			align: "right",
			render: (_v, record) => (
				<div className="vp-dump-actions">
					<PvButton
						size="sm"
						icon={<DownloadOutlined />}
						onClick={() => handleDownload(record)}
						disabled={downloadMutation.isPending}
					>
						Download
					</PvButton>
					<PvButton
						size="sm"
						variant="accent"
						icon={<UndoOutlined />}
						onClick={() => setPendingRestore(record)}
						disabled={restoreMutation.isPending}
					>
						Restore
					</PvButton>
					<PvButton
						size="sm"
						variant="danger"
						icon={<DeleteOutlined />}
						onClick={() => setPendingDelete(record)}
						aria-label="Delete backup"
					/>
				</div>
			),
		},
	];

	return (
		<PageContent>
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">Database Backups</h1>
					<p className="vp-page-subtitle">
						Dump the entire PostgreSQL database to your S3 <code>dump/</code>{" "}
						folder, download a copy, or restore the database from a previous
						backup.
					</p>
				</div>
				<div className="vp-row vp-row--wrap">
					<PvButton
						variant="primary"
						icon={<CloudUploadOutlined />}
						onClick={handleCreate}
						disabled={createMutation.isPending}
					>
						{createMutation.isPending ? "Dumping…" : "Create Backup"}
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

			<PvPanel title="db.backups" noPad className="vp-dump-table-panel">
				<PvTable
					columns={columns}
					data={dumps}
					rowKey="key"
					loading={isLoading}
					emptyText="No backups yet — create one to get started"
				/>
			</PvPanel>

			<PvModal
				open={pendingDelete != null}
				title="Delete Backup"
				confirmText="Delete"
				cancelText="Cancel"
				danger
				onConfirm={confirmDelete}
				onCancel={() => setPendingDelete(null)}
			>
				Delete the backup <strong>{pendingDelete?.filename}</strong> from S3?
				This removes the file only — the live database is untouched.
			</PvModal>

			<PvModal
				open={pendingRestore != null}
				title="Restore Database"
				confirmText="Restore Database"
				cancelText="Cancel"
				danger
				onConfirm={confirmRestore}
				onCancel={closeRestore}
			>
				<p className="vp-dump-warn">
					⚠️ This <strong>overwrites the entire live database</strong> with the
					contents of <strong>{pendingRestore?.filename}</strong>. Every current
					row is wiped and replaced. This cannot be undone.
				</p>
				<p>
					Type <code>RESTORE</code> to confirm:
				</p>
				<input
					className="vp-dump-confirm-input"
					value={restoreConfirmText}
					onChange={(e) => setRestoreConfirmText(e.target.value)}
					placeholder="RESTORE"
					autoComplete="off"
				/>
			</PvModal>
		</PageContent>
	);
};

export default DbDump;
