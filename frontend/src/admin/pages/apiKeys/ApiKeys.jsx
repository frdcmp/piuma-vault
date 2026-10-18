import {
	CopyOutlined,
	DeleteOutlined,
	EditOutlined,
	PlusOutlined,
	ReloadOutlined,
	StopOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

import { useState } from "react";
import {
	PvButton,
	PvCheckbox,
	PvDateTimePicker,
	PvField,
	PvIconButton,
	PvInput,
	PvModal,
	PvPanel,
	PvSegmented,
	PvTable,
	pvConfirm,
	pvMessage,
} from "@/ui";
import {
	useCreateApiKey,
	useDeleteApiKey,
	useGetApiKeys,
	useRevokeApiKey,
	useUpdateApiKey,
} from "../../../queries";
import { formatDate, timeAgo } from "../../../utils/dateTime";
import { PageContent } from "../../components/layout/PageLayout";
import "./apiKeys.css";

const SCOPE_OPTIONS = [
	{
		label: "Read",
		value: "notes.read",
		description: "List, search, and view notes, tags, and folders",
	},
	{
		label: "Write",
		value: "notes.write",
		description: "Create, update, and delete notes",
	},
	{
		label: "Storage",
		value: "storage.access",
		description:
			"Full access to Bunny storage: list, upload, download, and delete files and folders",
	},
	{
		label: "Tasks",
		value: "tasks.manage",
		description:
			"Full control of tasks & recurring tasks: list, create, update, complete, and delete",
	},
	{
		label: "Calendar",
		value: "calendar.manage",
		description:
			"Full control of calendar events: list, create, update, and delete",
	},
];

const SCOPE_TAG_CLASSES = {
	"notes.read": "vp-tag--green",
	"notes.write": "vp-tag--blue",
	"storage.access": "vp-tag--accent",
	"tasks.manage": "vp-tag--blue",
	"calendar.manage": "vp-tag--green",
};

const SCOPE_LABELS = {
	"notes.read": "Read",
	"notes.write": "Write",
	"storage.access": "Storage",
	"tasks.manage": "Tasks",
	"calendar.manage": "Calendar",
};

const STATUS_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "active", label: "Active" },
	{ value: "revoked", label: "Revoked" },
];

const ScopeTag = ({ scope }) => (
	<span className={`vp-tag ${SCOPE_TAG_CLASSES[scope] || ""}`.trim()}>
		{SCOPE_LABELS[scope] || scope}
	</span>
);

// Scope checklist used by the create + edit dialogs.
const ScopeChecklist = ({ value, onChange }) => {
	const toggle = (scope, on) =>
		onChange(on ? [...value, scope] : value.filter((s) => s !== scope));
	return (
		<div className="vp-keys-scopes">
			{SCOPE_OPTIONS.map((opt) => (
				<PvCheckbox
					key={opt.value}
					checked={value.includes(opt.value)}
					onChange={(on) => toggle(opt.value, on)}
					label={
						<>
							<strong>{opt.label}</strong>{" "}
							<span className="vp-muted">— {opt.description}</span>
						</>
					}
				/>
			))}
		</div>
	);
};

const EMPTY_CREATE = { name: "", permissions: [], expires_at: null };

const ApiKeysPage = () => {
	const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
	const [isEditModalVisible, setIsEditModalVisible] = useState(false);
	const [editingKey, setEditingKey] = useState(null);
	const [rawKeyData, setRawKeyData] = useState(null);
	const [createForm, setCreateForm] = useState(EMPTY_CREATE);
	const [createError, setCreateError] = useState(null);
	const [editForm, setEditForm] = useState(null); // { name, permissions, is_active }
	const [editError, setEditError] = useState(null);
	const [statusFilter, setStatusFilter] = useState("all");

	const { data: apiKeys, isLoading, refetch } = useGetApiKeys();
	const createMutation = useCreateApiKey();
	const updateMutation = useUpdateApiKey();
	const deleteMutation = useDeleteApiKey();
	const revokeMutation = useRevokeApiKey();

	const closeCreate = () => {
		setIsCreateModalVisible(false);
		setCreateForm(EMPTY_CREATE);
		setCreateError(null);
	};

	const closeEdit = () => {
		setIsEditModalVisible(false);
		setEditingKey(null);
		setEditForm(null);
		setEditError(null);
	};

	const handleCreate = (e) => {
		e.preventDefault();
		if (!createForm.name.trim()) {
			setCreateError("Please enter a name for this key");
			return;
		}
		const payload = {
			name: createForm.name,
			permissions: createForm.permissions.length
				? createForm.permissions
				: ["api.read"],
			expires_at: createForm.expires_at || null,
		};
		createMutation.mutate(payload, {
			onSuccess: (data) => {
				pvMessage.success("API key created successfully");
				setRawKeyData(data);
				closeCreate();
			},
			onError: () => {
				pvMessage.error("Failed to create API key");
			},
		});
	};

	const handleUpdate = (e) => {
		e.preventDefault();
		if (!editingKey || !editForm) return;
		if (!editForm.name.trim()) {
			setEditError("Please enter a name");
			return;
		}
		const payload = {
			name: editForm.name,
			permissions: editForm.permissions,
			is_active: editForm.is_active,
		};
		updateMutation.mutate(
			{ id: editingKey.id, body: payload },
			{
				onSuccess: () => {
					pvMessage.success("API key updated successfully");
					closeEdit();
				},
				onError: () => {
					pvMessage.error("Failed to update API key");
				},
			},
		);
	};

	const handleDelete = async (id) => {
		const ok = await pvConfirm({
			title: "Delete API Key",
			content:
				"This will permanently delete this API key. This action cannot be undone.",
			okText: "Delete",
			danger: true,
		});
		if (!ok) return;
		deleteMutation.mutate(id, {
			onSuccess: () => pvMessage.success("API key deleted"),
			onError: () => pvMessage.error("Failed to delete API key"),
		});
	};

	const handleRevoke = async (id) => {
		const ok = await pvConfirm({
			title: "Revoke API Key",
			content:
				"This will deactivate the API key. It can be re-enabled later by editing the key.",
			okText: "Revoke",
			danger: true,
		});
		if (!ok) return;
		revokeMutation.mutate(id, {
			onSuccess: () => pvMessage.success("API key revoked"),
			onError: () => pvMessage.error("Failed to revoke API key"),
		});
	};

	const showEditModal = (record) => {
		setEditingKey(record);
		setEditForm({
			name: record.name ?? "",
			permissions: record.permissions || [],
			is_active: !!record.is_active,
		});
		setEditError(null);
		setIsEditModalVisible(true);
	};

	const copyToClipboard = (text) => {
		navigator.clipboard.writeText(text).then(() => {
			pvMessage.success("Copied to clipboard!");
		});
	};

	const columns = [
		{
			title: "Name",
			dataIndex: "name",
			key: "name",
			render: (name) => <span className="vp-keys-name">{name}</span>,
		},
		{
			title: "Key Prefix",
			dataIndex: "key_prefix",
			key: "key_prefix",
			render: (prefix) => (
				<code className="vp-keys-code">{prefix}••••••••</code>
			),
		},
		{
			title: "Permissions",
			dataIndex: "permissions",
			key: "permissions",
			render: (permissions) => (
				<div className="vp-row vp-row--wrap">
					{(permissions || []).map((p) => (
						<ScopeTag key={p} scope={p} />
					))}
				</div>
			),
		},
		{
			title: "Status",
			dataIndex: "is_active",
			key: "is_active",
			render: (isActive, record) => {
				const isExpired =
					record.expires_at && dayjs(record.expires_at).isBefore(dayjs());
				if (isExpired) {
					return <span className="vp-tag vp-tag--accent">Expired</span>;
				}
				return isActive ? (
					<span className="vp-tag vp-tag--green">Active</span>
				) : (
					<span className="vp-tag vp-tag--red">Revoked</span>
				);
			},
		},
		{
			title: "Last Used",
			dataIndex: "last_used_at",
			key: "last_used_at",
			render: (date) =>
				date ? timeAgo(date) : <span className="vp-muted">Never</span>,
		},
		{
			title: "Created",
			dataIndex: "created_at",
			key: "created_at",
			render: (date) => formatDate(date),
			sorter: (a, b) => dayjs(a.created_at).unix() - dayjs(b.created_at).unix(),
		},
		{
			title: "Actions",
			key: "actions",
			render: (_, record) => (
				<div className="vp-row vp-keys-actions">
					<PvIconButton
						variant="ghost"
						icon={<EditOutlined />}
						label="Edit key"
						onClick={() => showEditModal(record)}
					/>
					{record.is_active && (
						<PvIconButton
							variant="ghost-danger"
							icon={<StopOutlined />}
							label="Revoke key"
							onClick={() => handleRevoke(record.id)}
						/>
					)}
					<PvIconButton
						variant="ghost-danger"
						icon={<DeleteOutlined />}
						label="Delete key"
						onClick={() => handleDelete(record.id)}
					/>
				</div>
			),
		},
	];

	const totalKeys = apiKeys?.length || 0;
	const activeKeys = apiKeys?.filter((k) => k.is_active).length || 0;
	const revokedKeys = apiKeys?.filter((k) => !k.is_active).length || 0;

	// The status filter that used to live in the antd column header.
	const tableData = (apiKeys || []).filter((k) =>
		statusFilter === "all"
			? true
			: statusFilter === "active"
				? k.is_active
				: !k.is_active,
	);

	return (
		<PageContent>
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">API Keys</h1>
					<p className="vp-page-subtitle">
						Manage API keys for third-party integrations and automated scripts
					</p>
				</div>
				<div className="vp-row vp-row--wrap">
					<PvButton
						variant="primary"
						icon={<PlusOutlined />}
						onClick={() => setIsCreateModalVisible(true)}
					>
						Create API Key
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

			{/* Stats */}
			<div className="vp-keys-stats">
				<div className="vp-card">
					<p className="vp-keys-stat-label">Total Keys</p>
					<p className="vp-keys-stat-value vp-keys-stat-value--accent">
						{totalKeys}
					</p>
				</div>
				<div className="vp-card">
					<p className="vp-keys-stat-label">Active</p>
					<p className="vp-keys-stat-value vp-keys-stat-value--green">
						{activeKeys}
					</p>
				</div>
				<div className="vp-card">
					<p className="vp-keys-stat-label">Revoked</p>
					<p className="vp-keys-stat-value vp-keys-stat-value--red">
						{revokedKeys}
					</p>
				</div>
			</div>

			{/* Table */}
			<PvPanel
				title="keys.table"
				noPad
				className="vp-keys-table-panel"
				extra={
					<PvSegmented
						size="sm"
						options={STATUS_FILTERS}
						value={statusFilter}
						onChange={setStatusFilter}
					/>
				}
			>
				<PvTable
					columns={columns}
					data={tableData}
					rowKey="id"
					loading={isLoading}
					defaultSort={{ key: "created_at", dir: "desc" }}
					pagination={{ pageSize: 10, hideOnSinglePage: true }}
				/>
			</PvPanel>

			{/* Create Modal */}
			<PvModal
				title="Create API Key"
				open={isCreateModalVisible}
				onCancel={closeCreate}
				footer={null}
				width={520}
			>
				<form onSubmit={handleCreate}>
					<PvField label="Key Name" required error={createError}>
						<PvInput
							placeholder="e.g. CI/CD Pipeline, Mobile App"
							value={createForm.name}
							invalid={!!createError}
							onChange={(e) => {
								setCreateForm((f) => ({ ...f, name: e.target.value }));
								setCreateError(null);
							}}
						/>
					</PvField>
					<PvField
						as="div"
						label="Permissions"
						hint="Select the scopes this key will have access to"
					>
						<ScopeChecklist
							value={createForm.permissions}
							onChange={(permissions) =>
								setCreateForm((f) => ({ ...f, permissions }))
							}
						/>
					</PvField>
					<PvField as="div" label="Expiration (optional)">
						<PvDateTimePicker
							value={createForm.expires_at}
							onChange={(expires_at) =>
								setCreateForm((f) => ({ ...f, expires_at }))
							}
							placeholder="Select expiration date"
						/>
					</PvField>
					<div className="vp-row vp-row--wrap">
						<PvButton
							variant="primary"
							type="submit"
							disabled={createMutation.isPending}
						>
							Create Key
						</PvButton>
						<PvButton onClick={closeCreate}>Cancel</PvButton>
					</div>
				</form>
			</PvModal>

			{/* Raw Key Display Modal */}
			<PvModal
				title="API Key Created"
				open={!!rawKeyData}
				onCancel={() => setRawKeyData(null)}
				footer={
					<PvButton variant="primary" onClick={() => setRawKeyData(null)}>
						I've copied the key
					</PvButton>
				}
				width={600}
				showClose={false}
				dismissOnOverlay={false}
			>
				<div className="vp-keys-warning">
					<strong className="vp-keys-warning-title">Save this key now!</strong>
					<span className="vp-muted">
						This is the only time the raw key will be shown. You won't be able
						to see it again.
					</span>
				</div>
				<div className="vp-keys-rawkey">
					<code className="vp-keys-rawkey-code">{rawKeyData?.raw_key}</code>
					<PvIconButton
						variant="ghost"
						icon={<CopyOutlined />}
						label="Copy key"
						onClick={() => copyToClipboard(rawKeyData?.raw_key)}
						className="vp-keys-rawkey-copy"
					/>
				</div>
				<div className="vp-row vp-row--wrap vp-keys-rawkey-meta">
					<span className="vp-muted">Name:</span>
					<strong>{rawKeyData?.name}</strong>
					<span className="vp-muted">| Prefix:</span>
					<code className="vp-keys-code">{rawKeyData?.key_prefix}</code>
				</div>
				<div className="vp-row vp-row--wrap vp-keys-rawkey-scopes">
					{(rawKeyData?.permissions || []).map((p) => (
						<ScopeTag key={p} scope={p} />
					))}
				</div>
			</PvModal>

			{/* Edit Modal */}
			<PvModal
				title="Edit API Key"
				open={isEditModalVisible && !!editForm}
				onCancel={closeEdit}
				footer={null}
				width={520}
			>
				{editForm && (
					<form onSubmit={handleUpdate}>
						<PvField label="Key Name" required error={editError}>
							<PvInput
								value={editForm.name}
								invalid={!!editError}
								onChange={(e) => {
									setEditForm((f) => ({ ...f, name: e.target.value }));
									setEditError(null);
								}}
							/>
						</PvField>
						<PvField as="div" label="Permissions">
							<ScopeChecklist
								value={editForm.permissions}
								onChange={(permissions) =>
									setEditForm((f) => ({ ...f, permissions }))
								}
							/>
						</PvField>
						<PvField as="div" label="Active">
							<PvCheckbox
								checked={editForm.is_active}
								onChange={(is_active) =>
									setEditForm((f) => ({ ...f, is_active }))
								}
								label="Key is active"
							/>
						</PvField>
						<div className="vp-row vp-row--wrap">
							<PvButton
								variant="primary"
								type="submit"
								disabled={updateMutation.isPending}
							>
								Update Key
							</PvButton>
							<PvButton onClick={closeEdit}>Cancel</PvButton>
						</div>
					</form>
				)}
			</PvModal>
		</PageContent>
	);
};

export default ApiKeysPage;
