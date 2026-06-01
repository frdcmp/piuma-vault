import {
	DeleteOutlined,
	EditOutlined,
	PlusOutlined,
	ReloadOutlined,
} from "@ant-design/icons";
import { Form, Input, Modal, Table } from "antd";
import { useState } from "react";
import {
	useCreateHealth,
	useDeleteHealth,
	useGetHealths,
	useUpdateHealth,
} from "../../../queries";
import { PageContent } from "../../components/layout/PageLayout";
import { PvButton, pvMessage } from "../../components/ui";
import "../../vault-pixel.css";
import "./health.css";

const Health = () => {
	const [isModalVisible, setIsModalVisible] = useState(false);
	const [editingHealth, setEditingHealth] = useState(null);
	const [form] = Form.useForm();

	const { data: healths, isLoading: healthsLoading, refetch } = useGetHealths();
	const createMutation = useCreateHealth();
	const updateMutation = useUpdateHealth();
	const deleteMutation = useDeleteHealth();

	const handleCreate = (values) => {
		createMutation.mutate(values.name, {
			onSuccess: () => {
				pvMessage.success("Health created successfully");
				setIsModalVisible(false);
				form.resetFields();
			},
			onError: () => {
				pvMessage.error("Failed to create health");
			},
		});
	};

	const handleUpdate = (values) => {
		updateMutation.mutate(
			{ id: editingHealth.id, name: values.name },
			{
				onSuccess: () => {
					pvMessage.success("Health updated successfully");
					setIsModalVisible(false);
					setEditingHealth(null);
					form.resetFields();
				},
				onError: () => {
					pvMessage.error("Failed to update health");
				},
			},
		);
	};

	const handleDelete = (id) => {
		deleteMutation.mutate(id, {
			onSuccess: () => {
				pvMessage.success("Health deleted successfully");
			},
			onError: () => {
				pvMessage.error("Failed to delete health");
			},
		});
	};

	const showModal = (health = null) => {
		setEditingHealth(health);
		setIsModalVisible(true);
		if (health) {
			form.setFieldsValue({ name: health.name });
		} else {
			form.resetFields();
		}
	};

	const handleCancel = () => {
		setIsModalVisible(false);
		setEditingHealth(null);
		form.resetFields();
	};

	const total = healths?.length || 0;

	return (
		<PageContent>
			<div className="vp-page">
				{/* Header */}
				<div className="vp-page-head">
					<div>
						<h1 className="vp-page-title">Health Database</h1>
						<p className="vp-page-subtitle">
							Manage and monitor your health database records in real-time
						</p>
					</div>
					<div className="vp-row vp-row--wrap">
						<PvButton
							variant="primary"
							icon={<PlusOutlined />}
							onClick={() => showModal()}
						>
							Add New Record
						</PvButton>
						<PvButton
							icon={<ReloadOutlined />}
							onClick={() => refetch()}
							disabled={healthsLoading}
						>
							Refresh
						</PvButton>
					</div>
				</div>

				<div className="vp-stack">
					{/* Stat */}
					<section className="vp-panel vp-health-stat">
						<div className="vp-panel-body">
							<span className="vp-label">Total Records</span>
							<div className="vp-health-stat-value">
								<span className="vp-accent">{total}</span>
								<span className="vp-muted vp-health-stat-suffix">entries</span>
							</div>
						</div>
					</section>

					{/* Table */}
					<section className="vp-panel">
						<header className="vp-panel-bar">
							<span className="vp-dots">
								<span />
								<span />
								<span />
							</span>
							<h3 className="vp-panel-title">
								Health Records — {total} record{total === 1 ? "" : "s"}
							</h3>
						</header>
						<div className="vp-panel-body vp-health-table">
							<Table
								dataSource={healths || []}
								rowKey="id"
								loading={healthsLoading}
								pagination={{
									pageSize: 10,
									showSizeChanger: true,
									showTotal: (t) => `Total ${t} records`,
								}}
								scroll={{ x: 600 }}
							>
								<Table.Column
									title="ID"
									dataIndex="id"
									key="id"
									width={100}
									render={(text) => (
										<span className="vp-accent vp-health-id">#{text}</span>
									)}
								/>
								<Table.Column
									title="Name"
									dataIndex="name"
									key="name"
									render={(text) => <span className="vp-text">{text}</span>}
								/>
								<Table.Column
									title="Actions"
									key="actions"
									width={180}
									align="center"
									render={(_, record) => (
										<div className="vp-row vp-health-actions">
											<PvButton
												size="sm"
												variant="ghost"
												icon={<EditOutlined />}
												onClick={() => showModal(record)}
											>
												Edit
											</PvButton>
											<PvButton
												size="sm"
												variant="danger"
												icon={<DeleteOutlined />}
												onClick={() => handleDelete(record.id)}
											>
												Delete
											</PvButton>
										</div>
									)}
								/>
							</Table>
						</div>
					</section>
				</div>

				<Modal
					title={editingHealth ? "Edit Health" : "Add New Health"}
					open={isModalVisible}
					onCancel={handleCancel}
					footer={null}
				>
					<Form
						form={form}
						onFinish={editingHealth ? handleUpdate : handleCreate}
						layout="vertical"
					>
						<Form.Item
							name="name"
							label="Name"
							rules={[{ required: true, message: "Please input the name!" }]}
						>
							<Input />
						</Form.Item>
						<Form.Item>
							<div className="vp-row">
								<PvButton variant="primary" type="submit">
									{editingHealth ? "Update" : "Create"}
								</PvButton>
								<PvButton onClick={handleCancel}>Cancel</PvButton>
							</div>
						</Form.Item>
					</Form>
				</Modal>
			</div>
		</PageContent>
	);
};

export default Health;
