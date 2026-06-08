import {
	CheckCircleOutlined,
	CloseCircleOutlined,
	DeleteOutlined,
	ExperimentOutlined,
	ReloadOutlined,
	RobotOutlined,
	ThunderboltOutlined,
} from "@ant-design/icons";
import {
	Empty,
	Input,
	Popconfirm,
	Progress,
	Segmented,
	Select,
	Spin,
	Table,
	Tabs,
	Tag,
	Tooltip,
	Typography,
} from "antd";
import { useMemo, useState } from "react";
import {
	useConfirmMemoryEntry,
	useDeleteMemoryEntry,
	useMemoryEntries,
	useMemoryOverview,
	useRejectMemoryEntry,
	useTurnLogs,
} from "../../../queries";
import { formatDateTime, timeAgo } from "../../../utils/dateTime";
import { PageContent } from "../../components/layout/PageLayout";
import { PvButton, pvMessage } from "../../components/ui";
import "../../vault-pixel.css";
import "./memory.css";

const AGENT = "vault_agent";

const STATUS_COLOR = {
	confirmed: "green",
	pending: "gold",
	rejected: "default",
};
const SOURCE_COLOR = {
	user_stated: "blue",
	agent_observed: "cyan",
	dialectic_derived: "purple",
	imported: "geekblue",
};
const SOURCE_LABEL = {
	user_stated: "user-stated",
	agent_observed: "observed",
	dialectic_derived: "derived",
	imported: "imported",
};

const StatusTag = ({ status }) => (
	<Tag color={STATUS_COLOR[status] || "default"} style={{ marginInlineEnd: 0 }}>
		{status}
	</Tag>
);
const SourceTag = ({ source }) => (
	<Tag color={SOURCE_COLOR[source] || "default"} style={{ marginInlineEnd: 0 }}>
		{SOURCE_LABEL[source] || source}
	</Tag>
);

/** A clickable layer summary card. */
const LayerCard = ({
	icon,
	layer,
	title,
	subtitle,
	count,
	accent,
	onClick,
	active,
}) => (
	<button
		type="button"
		className={`mem-layer ${active ? "mem-layer--active" : ""}`}
		style={{ "--mem-accent": accent }}
		onClick={onClick}
	>
		<div className="mem-layer-head">
			<span className="mem-layer-icon">{icon}</span>
			<span className="mem-layer-tag">{layer}</span>
		</div>
		<div className="mem-layer-count">{count}</div>
		<div className="mem-layer-title">{title}</div>
		<div className="mem-layer-sub">{subtitle}</div>
	</button>
);

/** L1 capacity gauge. */
const L1Gauge = ({ label, chars, cap, pct, content }) => (
	<div className="mem-gauge">
		<div className="mem-gauge-head">
			<span className="mem-gauge-label">{label}</span>
			<span className="mem-gauge-num">
				{chars} / {cap} chars · {pct}%
			</span>
		</div>
		<Progress
			percent={pct}
			showInfo={false}
			strokeColor={pct >= 80 ? "#d4380d" : pct >= 50 ? "#d48806" : "#389e0d"}
		/>
		<pre className="mem-gauge-body">
			{content?.trim() ? content : <span className="mem-muted">— empty —</span>}
		</pre>
	</div>
);

const Memory = () => {
	const [tab, setTab] = useState("entries");
	const [status, setStatus] = useState("all");
	const [source, setSource] = useState();
	const [category, setCategory] = useState();
	const [search, setSearch] = useState("");

	const overview = useMemoryOverview(AGENT);
	const entryFilters = useMemo(() => {
		const f = { agent: AGENT };
		if (status !== "all") f.status = status;
		if (source) f.source = source;
		if (category) f.category = category;
		if (search.trim()) f.q = search.trim();
		return f;
	}, [status, source, category, search]);
	const entries = useMemoryEntries(entryFilters);
	const turnLogs = useTurnLogs(
		{ agent: AGENT },
		{ enabled: tab === "inspector" },
	);

	const confirmMut = useConfirmMemoryEntry();
	const rejectMut = useRejectMemoryEntry();
	const deleteMut = useDeleteMemoryEntry();

	const stats = overview.data?.stats;
	const l1 = overview.data?.l1;
	const byStatus = stats?.by_status || {};
	const bySource = stats?.by_source || {};

	const refreshAll = () => {
		overview.refetch();
		entries.refetch();
		if (tab === "inspector") turnLogs.refetch();
	};

	const act = (mut, id, verb) =>
		mut.mutate(id, {
			onSuccess: () => pvMessage.success(`Entry ${verb}`),
			onError: () => pvMessage.error(`Could not ${verb} entry`),
		});

	// Clicking a layer card focuses the entries tab on that slice.
	const focusLayer = (next) => {
		setTab("entries");
		setStatus(next.status ?? "all");
		setSource(next.source);
	};

	const entryColumns = [
		{
			title: "Memory line",
			dataIndex: "content",
			key: "content",
			render: (text, row) => (
				<div className="mem-cell-content">
					<span>{text}</span>
					{!row.embedded && (
						<Tooltip title="No embedding yet (queued / provider down)">
							<Tag color="orange" className="mem-noembed">
								no vector
							</Tag>
						</Tooltip>
					)}
				</div>
			),
		},
		{
			title: "Status",
			dataIndex: "status",
			key: "status",
			width: 110,
			render: (s) => <StatusTag status={s} />,
		},
		{
			title: "Source",
			dataIndex: "source",
			key: "source",
			width: 120,
			render: (s) => <SourceTag source={s} />,
		},
		{
			title: "Category",
			dataIndex: "category",
			key: "category",
			width: 120,
			render: (c) =>
				c ? <Tag>{c}</Tag> : <span className="mem-muted">—</span>,
		},
		{
			title: "Conf.",
			dataIndex: "confidence",
			key: "confidence",
			width: 80,
			render: (c) => <span className="mem-muted">{c}</span>,
		},
		{
			title: "Created",
			dataIndex: "created_at",
			key: "created_at",
			width: 120,
			render: (d) => (
				<Tooltip
					title={formatDateTime(d)?.date + " " + formatDateTime(d)?.time}
				>
					<span className="mem-muted">{timeAgo(d)}</span>
				</Tooltip>
			),
		},
		{
			title: "",
			key: "actions",
			width: 120,
			render: (_, row) => (
				<div className="mem-actions">
					{row.status !== "confirmed" && (
						<Tooltip title="Confirm (promote to a trusted fact)">
							<PvButton
								size="small"
								icon={<CheckCircleOutlined />}
								onClick={() => act(confirmMut, row.id, "confirmed")}
							/>
						</Tooltip>
					)}
					{row.status !== "rejected" && (
						<Tooltip title="Reject (stop retrieving it)">
							<PvButton
								size="small"
								icon={<CloseCircleOutlined />}
								onClick={() => act(rejectMut, row.id, "rejected")}
							/>
						</Tooltip>
					)}
					<Popconfirm
						title="Delete this entry permanently?"
						onConfirm={() => act(deleteMut, row.id, "deleted")}
						okText="Delete"
						okButtonProps={{ danger: true }}
					>
						<PvButton size="small" danger icon={<DeleteOutlined />} />
					</Popconfirm>
				</div>
			),
		},
	];

	const inspectorColumns = [
		{
			title: "When",
			dataIndex: "created_at",
			key: "created_at",
			width: 130,
			render: (d) => <span className="mem-muted">{timeAgo(d)}</span>,
		},
		{
			title: "Conversation",
			dataIndex: "title",
			key: "title",
			render: (t) => t || <span className="mem-muted">untitled</span>,
		},
		{
			title: "Retrieved",
			key: "retrieved",
			width: 110,
			render: (_, row) => (
				<Tag color={row.retrieved?.length ? "green" : "default"}>
					{row.retrieved?.length || 0} memo
				</Tag>
			),
		},
		{
			title: "L1 usage",
			key: "l1",
			width: 130,
			render: (_, row) =>
				row.l1_memory_pct != null ? (
					<Progress
						percent={row.l1_memory_pct}
						size="small"
						format={(p) => `${p}%`}
					/>
				) : (
					<span className="mem-muted">—</span>
				),
		},
	];

	return (
		<PageContent>
			<div className="mem-header">
				<div>
					<Typography.Title level={3} style={{ margin: 0 }}>
						Memory
					</Typography.Title>
					<Typography.Text type="secondary">
						Scout and curate the agent's layered memory — L1 always-in-context,
						L2 semantic store, L4 dialectic-derived.
					</Typography.Text>
				</div>
				<PvButton icon={<ReloadOutlined />} onClick={refreshAll}>
					Refresh
				</PvButton>
			</div>

			{/* Layer map */}
			<div className="mem-layers">
				<LayerCard
					layer="L1"
					icon={<RobotOutlined />}
					title="Always-in-context"
					subtitle={`${l1?.memory_pct ?? 0}% of scratchpad used`}
					count={l1 ? `${l1.memory_pct ?? 0}%` : "—"}
					accent="#1677ff"
					active={tab === "l1"}
					onClick={() => setTab("l1")}
				/>
				<LayerCard
					layer="L2"
					icon={<ThunderboltOutlined />}
					title="Confirmed facts"
					subtitle={`${bySource.user_stated || 0} user · ${bySource.agent_observed || 0} observed`}
					count={byStatus.confirmed ?? 0}
					accent="#389e0d"
					active={tab === "entries" && status === "confirmed"}
					onClick={() => focusLayer({ status: "confirmed" })}
				/>
				<LayerCard
					layer="L4"
					icon={<ExperimentOutlined />}
					title="Derived (pending)"
					subtitle="low-trust, awaiting confirmation"
					count={byStatus.pending ?? 0}
					accent="#722ed1"
					active={tab === "entries" && status === "pending"}
					onClick={() =>
						focusLayer({ status: "pending", source: "dialectic_derived" })
					}
				/>
				<LayerCard
					layer="∑"
					icon={<CheckCircleOutlined />}
					title="Total active"
					subtitle={`${stats?.unembedded ?? 0} awaiting embedding`}
					count={stats?.total ?? 0}
					accent="#08979c"
					active={tab === "entries" && status === "all" && !source}
					onClick={() => focusLayer({ status: "all" })}
				/>
			</div>

			<Tabs
				activeKey={tab}
				onChange={setTab}
				items={[
					{
						key: "entries",
						label: "Entries (L2 / L4)",
						children: (
							<>
								<div className="mem-filters">
									<Segmented
										value={status}
										onChange={setStatus}
										options={[
											{ label: "All", value: "all" },
											{ label: "Confirmed", value: "confirmed" },
											{ label: "Pending", value: "pending" },
											{ label: "Rejected", value: "rejected" },
										]}
									/>
									<Select
										allowClear
										placeholder="Source"
										style={{ minWidth: 150 }}
										value={source}
										onChange={setSource}
										options={[
											{ label: "User-stated", value: "user_stated" },
											{ label: "Observed", value: "agent_observed" },
											{ label: "Derived", value: "dialectic_derived" },
											{ label: "Imported", value: "imported" },
										]}
									/>
									<Select
										allowClear
										placeholder="Category"
										style={{ minWidth: 150 }}
										value={category}
										onChange={setCategory}
										options={(stats?.by_category || []).map((c) => ({
											label: `${c.category} (${c.count})`,
											value: c.category,
										}))}
									/>
									<Input.Search
										allowClear
										placeholder="Search content…"
										style={{ maxWidth: 240 }}
										onSearch={setSearch}
										onChange={(e) => !e.target.value && setSearch("")}
									/>
								</div>
								<Table
									rowKey="id"
									size="small"
									loading={entries.isLoading}
									dataSource={entries.data || []}
									columns={entryColumns}
									pagination={{ pageSize: 20, hideOnSinglePage: true }}
									locale={{
										emptyText: <Empty description="No memory entries" />,
									}}
								/>
							</>
						),
					},
					{
						key: "l1",
						label: "Always-in-context (L1)",
						children: overview.isLoading ? (
							<Spin />
						) : (
							<div className="mem-l1">
								<L1Gauge
									label="memory — agent scratchpad"
									chars={l1?.memory_chars ?? 0}
									cap={l1?.memory_cap ?? 0}
									pct={l1?.memory_pct ?? 0}
									content={l1?.memory}
								/>
								<L1Gauge
									label="user_context — profile / preferences"
									chars={l1?.user_context_chars ?? 0}
									cap={l1?.user_context_cap ?? 0}
									pct={l1?.user_context_pct ?? 0}
									content={l1?.user_context}
								/>
							</div>
						),
					},
					{
						key: "inspector",
						label: "Turn inspector",
						children: (
							<Table
								rowKey="id"
								size="small"
								loading={turnLogs.isLoading}
								dataSource={turnLogs.data || []}
								columns={inspectorColumns}
								pagination={{ pageSize: 15, hideOnSinglePage: true }}
								locale={{
									emptyText: (
										<Empty description="No turns logged yet — chat with the agent first" />
									),
								}}
								expandable={{
									expandedRowRender: (row) => (
										<div className="mem-retrieved">
											{row.retrieved?.length ? (
												row.retrieved.map((r) => (
													<div key={r.id} className="mem-retrieved-row">
														<SourceTag source={r.source} />
														<StatusTag status={r.status} />
														<span className="mem-retrieved-sim">
															{Math.round((1 - (r.distance ?? 1)) * 100)}%
														</span>
														<span>{r.content}</span>
													</div>
												))
											) : (
												<span className="mem-muted">
													Nothing cleared the retrieval floor this turn.
												</span>
											)}
										</div>
									),
								}}
							/>
						),
					},
				]}
			/>
		</PageContent>
	);
};

export default Memory;
