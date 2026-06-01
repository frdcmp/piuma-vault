import {
	CopyOutlined,
	DeleteOutlined,
	EditOutlined,
	KeyOutlined,
	PlusOutlined,
	ReloadOutlined,
	StopOutlined,
} from "@ant-design/icons";
import {
	Button,
	Checkbox,
	Col,
	DatePicker,
	Form,
	Input,
	Modal,
	message,
	Row,
	Space,
	Table,
} from "antd";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

import { useState } from "react";
import {
	useCreateApiKey,
	useDeleteApiKey,
	useGetApiKeys,
	useRevokeApiKey,
	useUpdateApiKey,
} from "../../../queries";
import { formatDate, timeAgo } from "../../../utils/dateTime";
import { PageContent } from "../../components/layout/PageLayout";
import { PvButton, PvPanel } from "../../components/ui";
import "../../vault-pixel.css";
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
];

const SCOPE_TAG_CLASSES = {
	"notes.read": "vp-tag--green",
	"notes.write": "vp-tag--blue",
	"storage.access": "vp-tag--accent",
};

const SCOPE_LABELS = {
	"notes.read": "Read",
	"notes.write": "Write",
	"storage.access": "Storage",
};

const ScopeTag = ({ scope }) => (
	<span className={`vp-tag ${SCOPE_TAG_CLASSES[scope] || ""}`.trim()}>
		{SCOPE_LABELS[scope] || scope}
	</span>
);

const ApiKeysPage = () => {
	const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
	const [isEditModalVisible, setIsEditModalVisible] = useState(false);
	const [editingKey, setEditingKey] = useState(null);
	const [rawKeyData, setRawKeyData] = useState(null);
	const [createForm] = Form.useForm();
	const [editForm] = Form.useForm();

	const { data: apiKeys, isLoading, refetch } = useGetApiKeys();
	const createMutation = useCreateApiKey();
	const updateMutation = useUpdateApiKey();
	const deleteMutation = useDeleteApiKey();
	const revokeMutation = useRevokeApiKey();

	const handleCreate = (values) => {
		const payload = {
			name: values.name,
			permissions: values.permissions || ["api.read"],
			expires_at: values.expires_at ? values.expires_at.toISOString() : null,
		};
		createMutation.mutate(payload, {
			onSuccess: (data) => {
				message.success("API key created successfully");
				setRawKeyData(data);
				setIsCreateModalVisible(false);
				createForm.resetFields();
			},
			onError: () => {
				message.error("Failed to create API key");
			},
		});
	};

	const handleUpdate = (values) => {
		if (!editingKey) return;
		const payload = {
			name: values.name,
			permissions: values.permissions,
			is_active: values.is_active,
		};
		updateMutation.mutate(
			{ id: editingKey.id, body: payload },
			{
				onSuccess: () => {
					message.success("API key updated successfully");
					setIsEditModalVisible(false);
					setEditingKey(null);
					editForm.resetFields();
				},
				onError: () => {
					message.error("Failed to update API key");
				},
			},
		);
	};

	const handleDelete = (id) => {
		Modal.confirm({
			title: "Delete API Key",
			content:
				"This will permanently delete this API key. This action cannot be undone.",
			okText: "Delete",
			okType: "danger",
			onOk: () => {
				deleteMutation.mutate(id, {
					onSuccess: () => message.success("API key deleted"),
					onError: () => message.error("Failed to delete API key"),
				});
			},
		});
	};

	const handleRevoke = (id) => {
		Modal.confirm({
			title: "Revoke API Key",
			content:
				"This will deactivate the API key. It can be re-enabled later by editing the key.",
			okText: "Revoke",
			okType: "danger",
			onOk: () => {
				revokeMutation.mutate(id, {
					onSuccess: () => message.success("API key revoked"),
					onError: () => message.error("Failed to revoke API key"),
				});
			},
		});
	};

	const showEditModal = (record) => {
		setEditingKey(record);
		editForm.setFieldsValue({
			name: record.name,
			permissions: record.permissions,
			is_active: record.is_active,
		});
		setIsEditModalVisible(true);
	};

	const copyToClipboard = (text) => {
		navigator.clipboard.writeText(text).then(() => {
			message.success("Copied to clipboard!");
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
			filters: [
				{ text: "Active", value: true },
				{ text: "Revoked", value: false },
			],
			onFilter: (value, record) => record.is_active === value,
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
			defaultSortOrder: "descend",
		},
		{
			title: "Actions",
			key: "actions",
			render: (_, record) => (
				<Space>
					<Button
						type="text"
						icon={<EditOutlined />}
						onClick={() => showEditModal(record)}
					/>
					{record.is_active && (
						<Button
							type="text"
							danger
							icon={<StopOutlined />}
							onClick={() => handleRevoke(record.id)}
						/>
					)}
					<Button
						type="text"
						danger
						icon={<DeleteOutlined />}
						onClick={() => handleDelete(record.id)}
					/>
				</Space>
			),
		},
	];

	const totalKeys = apiKeys?.length || 0;
	const activeKeys = apiKeys?.filter((k) => k.is_active).length || 0;
	const revokedKeys = apiKeys?.filter((k) => !k.is_active).length || 0;

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
			<PvPanel title="keys.table" noPad className="vp-keys-table-panel">
				<Table
					className="vp-table"
					columns={columns}
					dataSource={apiKeys || []}
					rowKey="id"
					loading={isLoading}
					pagination={{ pageSize: 10, showSizeChanger: true }}
				/>
			</PvPanel>

			{/* Create Modal */}
			<Modal
				className="vp-modal"
				title={
					<Space>
						<KeyOutlined />
						<span>Create API Key</span>
					</Space>
				}
				open={isCreateModalVisible}
				onCancel={() => {
					setIsCreateModalVisible(false);
					createForm.resetFields();
				}}
				footer={null}
				width={520}
			>
				<Form form={createForm} onFinish={handleCreate} layout="vertical">
					<Form.Item
						name="name"
						label="Key Name"
						rules={[
							{ required: true, message: "Please enter a name for this key" },
						]}
					>
						<Input placeholder="e.g. CI/CD Pipeline, Mobile App" />
					</Form.Item>
					<Form.Item
						name="permissions"
						label="Permissions"
						extra="Select the scopes this key will have access to"
					>
						<Checkbox.Group>
							<Row gutter={[8, 8]}>
								{SCOPE_OPTIONS.map((opt) => (
									<Col span={24} key={opt.value}>
										<Checkbox value={opt.value}>
											<strong>{opt.label}</strong>{" "}
											<span className="vp-muted">— {opt.description}</span>
										</Checkbox>
									</Col>
								))}
							</Row>
						</Checkbox.Group>
					</Form.Item>
					<Form.Item name="expires_at" label="Expiration (optional)">
						<DatePicker
							style={{ width: "100%" }}
							showTime
							placeholder="Select expiration date"
						/>
					</Form.Item>
					<Form.Item>
						<div className="vp-row vp-row--wrap">
							<PvButton
								variant="primary"
								type="submit"
								disabled={createMutation.isPending}
							>
								Create Key
							</PvButton>
							<PvButton
								onClick={() => {
									setIsCreateModalVisible(false);
									createForm.resetFields();
								}}
							>
								Cancel
							</PvButton>
						</div>
					</Form.Item>
				</Form>
			</Modal>

			{/* Raw Key Display Modal */}
			<Modal
				className="vp-modal"
				title={
					<Space>
						<KeyOutlined />
						<span>API Key Created</span>
					</Space>
				}
				open={!!rawKeyData}
				onCancel={() => setRawKeyData(null)}
				footer={
					<PvButton variant="primary" onClick={() => setRawKeyData(null)}>
						I've copied the key
					</PvButton>
				}
				width={600}
				closable={false}
				maskClosable={false}
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
					<Button
						type="text"
						icon={<CopyOutlined />}
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
			</Modal>

			{/* Edit Modal */}
			<Modal
				className="vp-modal"
				title={
					<Space>
						<EditOutlined />
						<span>Edit API Key</span>
					</Space>
				}
				open={isEditModalVisible}
				onCancel={() => {
					setIsEditModalVisible(false);
					setEditingKey(null);
					editForm.resetFields();
				}}
				footer={null}
				width={520}
			>
				<Form form={editForm} onFinish={handleUpdate} layout="vertical">
					<Form.Item
						name="name"
						label="Key Name"
						rules={[{ required: true, message: "Please enter a name" }]}
					>
						<Input />
					</Form.Item>
					<Form.Item name="permissions" label="Permissions">
						<Checkbox.Group>
							<Row gutter={[8, 8]}>
								{SCOPE_OPTIONS.map((opt) => (
									<Col span={24} key={opt.value}>
										<Checkbox value={opt.value}>
											<strong>{opt.label}</strong>{" "}
											<span className="vp-muted">— {opt.description}</span>
										</Checkbox>
									</Col>
								))}
							</Row>
						</Checkbox.Group>
					</Form.Item>
					<Form.Item name="is_active" label="Active" valuePropName="checked">
						<Checkbox>Key is active</Checkbox>
					</Form.Item>
					<Form.Item>
						<div className="vp-row vp-row--wrap">
							<PvButton
								variant="primary"
								type="submit"
								disabled={updateMutation.isPending}
							>
								Update Key
							</PvButton>
							<PvButton
								onClick={() => {
									setIsEditModalVisible(false);
									setEditingKey(null);
									editForm.resetFields();
								}}
							>
								Cancel
							</PvButton>
						</div>
					</Form.Item>
				</Form>
			</Modal>
		</PageContent>
	);
};

export default ApiKeysPage;
