import { ReloadOutlined } from "@ant-design/icons";
import { DatePicker, Select, Table } from "antd";
import { useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { useTokenUsage } from "../../../queries";
import { PageContent } from "../../components/layout/PageLayout";
import { PvButton } from "../../components/ui";
import "../../vault-pixel.css";
import "./token-usage.css";

const { RangePicker } = DatePicker;

const SOURCE_OPTIONS = [
	{ value: "chat", label: "Chat" },
	{ value: "embedding:notes", label: "Embedding · Notes" },
	{ value: "embedding:memory", label: "Embedding · Memory" },
	{ value: "embedding:search", label: "Embedding · Search" },
	{ value: "embedding:chat", label: "Embedding · Chat" },
];

const num = new Intl.NumberFormat("en-US");
const fmtTokens = (n) => num.format(n || 0);
// Compact form for the big stat cards so large counts don't overflow the card
// (e.g. 1,187,685 → 1.19M, 393,704 → 394k). Tables still use the exact format.
const fmtCompact = (n) => {
	const v = n || 0;
	if (v < 1000) return String(v);
	if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
	if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
	return `${(v / 1_000_000_000).toFixed(2)}B`;
};
// Costs ≥ $0.0001 read as plain dollars; tiny spend (e.g. embeddings, a few
// hundred tokens at $0.13/M) would round to $0.0000, so show it in exponential
// form (e.g. $5.23e-5) instead of hiding it.
const fmtUsd = (n) => {
	const v = n || 0;
	if (v === 0) return "$0.0000";
	if (v >= 0.0001) return `$${v.toFixed(4)}`;
	return `$${v.toExponential(2)}`;
};

// Chart series colors — mapped to the vault-pixel accent tokens. (SVG `stroke`
// / `fill` attributes can't resolve CSS vars, so these mirror the hex values.)
const SERIES = {
	input: "#6ab0ff", // --vp-accent-4 (blue)
	cached: "#3f6e8c", // dim blue
	output: "#5cd0a9", // --vp-accent-2 (green)
	cost: "#f7c948", // --vp-accent (yellow)
};
const AXIS = "#8a93a3"; // --vp-muted
const GRID = "#2a2f39"; // --vp-border-soft

const StatCard = ({ label, value, accent, suffix, title }) => (
	<section className="vp-panel tu-stat">
		<div className="vp-panel-body">
			<span className="vp-label">{label}</span>
			<div className="tu-stat-value">
				<span className={accent || "vp-accent"} title={title}>
					{value}
				</span>
				{suffix ? (
					<span className="vp-muted tu-stat-suffix">{suffix}</span>
				) : null}
			</div>
		</div>
	</section>
);

const TokenUsage = () => {
	const [range, setRange] = useState(null); // [dayjs, dayjs] | null
	const [source, setSource] = useState(undefined);

	const params = useMemo(() => {
		const p = {};
		if (range?.[0]) p.from = range[0].format("YYYY-MM-DD");
		if (range?.[1]) p.to = range[1].add(1, "day").format("YYYY-MM-DD"); // `to` is exclusive
		if (source) p.source = source;
		return p;
	}, [range, source]);

	const { data, isLoading, refetch, isFetching } = useTokenUsage(params);

	const summary = data?.summary || {};
	const byModel = data?.by_model || [];
	const bySource = data?.by_source || [];
	const byDay = data?.by_day || [];

	const modelChart = useMemo(
		() =>
			byModel.map((m) => ({
				name: m.model,
				input: m.tokens_input,
				output: m.tokens_output,
				cached: m.tokens_cached,
			})),
		[byModel],
	);

	return (
		<PageContent>
			<div className="vp-page tu-root">
				<div className="vp-page-head">
					<div>
						<h1 className="vp-page-title">Token Usage</h1>
						<p className="vp-page-subtitle">
							Spend and token volume per model, source, and over time — chat and
							embeddings.
						</p>
					</div>
					<div className="vp-row vp-row--wrap">
						<RangePicker
							value={range}
							onChange={setRange}
							allowEmpty={[true, true]}
							popupClassName="tu-pop"
						/>
						<Select
							allowClear
							placeholder="All sources"
							style={{ minWidth: 180 }}
							value={source}
							onChange={setSource}
							options={SOURCE_OPTIONS}
							popupClassName="tu-pop"
						/>
						<PvButton
							icon={<ReloadOutlined />}
							onClick={() => refetch()}
							disabled={isFetching}
						>
							Refresh
						</PvButton>
					</div>
				</div>

				<div className="vp-stack">
					{/* Summary cards */}
					<div className="tu-stats">
						<StatCard
							label="Total cost"
							value={fmtUsd(summary.cost_usd)}
							accent="vp-accent"
							suffix="est."
						/>
						<StatCard
							label="Total tokens"
							value={fmtCompact(summary.total_tokens)}
							title={`${fmtTokens(summary.total_tokens)} tokens`}
							suffix="tokens"
						/>
						<StatCard
							label="Input"
							value={fmtCompact(summary.tokens_input)}
							title={`${fmtTokens(summary.tokens_input)} tokens`}
							suffix="tokens"
						/>
						<StatCard
							label="Output"
							value={fmtCompact(summary.tokens_output)}
							title={`${fmtTokens(summary.tokens_output)} tokens`}
							suffix="tokens"
						/>
						<StatCard
							label="Cached (read)"
							value={fmtCompact(summary.tokens_cached)}
							title={`${fmtTokens(summary.tokens_cached)} tokens`}
							suffix="tokens"
						/>
						<StatCard
							label="Calls"
							value={fmtCompact(summary.calls)}
							title={`${fmtTokens(summary.calls)} requests`}
							suffix="requests"
						/>
					</div>

					{/* Usage over time */}
					<section className="vp-panel">
						<header className="vp-panel-bar">
							<span className="vp-dots">
								<span />
								<span />
								<span />
							</span>
							<h3 className="vp-panel-title">Usage over time</h3>
						</header>
						<div className="vp-panel-body tu-chart">
							<ResponsiveContainer width="100%" height={280}>
								<LineChart data={byDay}>
									<CartesianGrid stroke={GRID} strokeDasharray="3 3" />
									<XAxis
										dataKey="day"
										fontSize={11}
										stroke={AXIS}
										tick={{ fill: AXIS }}
									/>
									<YAxis
										yAxisId="left"
										fontSize={11}
										stroke={AXIS}
										tick={{ fill: AXIS }}
									/>
									<YAxis
										yAxisId="right"
										orientation="right"
										fontSize={11}
										stroke={AXIS}
										tick={{ fill: AXIS }}
										tickFormatter={(v) => `$${v.toFixed(2)}`}
									/>
									<Tooltip
										contentStyle={{
											background: "#1b1e25",
											border: "2px solid #3a4150",
											borderRadius: 0,
											fontFamily: "var(--vp-font)",
										}}
										labelStyle={{ color: "#d6dbe5" }}
									/>
									<Legend />
									<Line
										yAxisId="left"
										type="monotone"
										dataKey="tokens_input"
										name="Input"
										stroke={SERIES.input}
										dot={false}
									/>
									<Line
										yAxisId="left"
										type="monotone"
										dataKey="tokens_output"
										name="Output"
										stroke={SERIES.output}
										dot={false}
									/>
									<Line
										yAxisId="right"
										type="monotone"
										dataKey="cost_usd"
										name="Cost ($)"
										stroke={SERIES.cost}
										dot={false}
									/>
								</LineChart>
							</ResponsiveContainer>
						</div>
					</section>

					{/* Per-model bar chart */}
					<section className="vp-panel">
						<header className="vp-panel-bar">
							<span className="vp-dots">
								<span />
								<span />
								<span />
							</span>
							<h3 className="vp-panel-title">Tokens per model</h3>
						</header>
						<div className="vp-panel-body tu-chart">
							<ResponsiveContainer width="100%" height={280}>
								<BarChart data={modelChart}>
									<CartesianGrid stroke={GRID} strokeDasharray="3 3" />
									<XAxis
										dataKey="name"
										fontSize={11}
										stroke={AXIS}
										tick={{ fill: AXIS }}
									/>
									<YAxis fontSize={11} stroke={AXIS} tick={{ fill: AXIS }} />
									<Tooltip
										cursor={{ fill: "rgba(255,255,255,0.04)" }}
										contentStyle={{
											background: "#1b1e25",
											border: "2px solid #3a4150",
											borderRadius: 0,
											fontFamily: "var(--vp-font)",
										}}
										labelStyle={{ color: "#d6dbe5" }}
									/>
									<Legend />
									<Bar
										dataKey="input"
										name="Input"
										stackId="t"
										fill={SERIES.input}
									/>
									<Bar
										dataKey="cached"
										name="Cached"
										stackId="t"
										fill={SERIES.cached}
									/>
									<Bar
										dataKey="output"
										name="Output"
										stackId="t"
										fill={SERIES.output}
									/>
								</BarChart>
							</ResponsiveContainer>
						</div>
					</section>

					{/* Per-model table */}
					<section className="vp-panel">
						<header className="vp-panel-bar">
							<span className="vp-dots">
								<span />
								<span />
								<span />
							</span>
							<h3 className="vp-panel-title">By model</h3>
						</header>
						<div className="vp-panel-body">
							<Table
								dataSource={byModel}
								rowKey="model"
								loading={isLoading}
								pagination={false}
								size="small"
								scroll={{ x: 720 }}
							>
								<Table.Column title="Model" dataIndex="model" key="model" />
								<Table.Column
									title="Provider"
									dataIndex="provider_kind"
									key="provider_kind"
									render={(v) => v || "—"}
								/>
								<Table.Column
									title="Input"
									dataIndex="tokens_input"
									key="tokens_input"
									align="right"
									render={fmtTokens}
								/>
								<Table.Column
									title="Output"
									dataIndex="tokens_output"
									key="tokens_output"
									align="right"
									render={fmtTokens}
								/>
								<Table.Column
									title="Cached"
									dataIndex="tokens_cached"
									key="tokens_cached"
									align="right"
									render={fmtTokens}
								/>
								<Table.Column
									title="Calls"
									dataIndex="calls"
									key="calls"
									align="right"
									render={fmtTokens}
								/>
								<Table.Column
									title="Cost"
									dataIndex="cost_usd"
									key="cost_usd"
									align="right"
									render={fmtUsd}
								/>
							</Table>
						</div>
					</section>

					{/* Per-source table */}
					<section className="vp-panel">
						<header className="vp-panel-bar">
							<span className="vp-dots">
								<span />
								<span />
								<span />
							</span>
							<h3 className="vp-panel-title">By source</h3>
						</header>
						<div className="vp-panel-body">
							<Table
								dataSource={bySource}
								rowKey="source"
								loading={isLoading}
								pagination={false}
								size="small"
								scroll={{ x: 600 }}
							>
								<Table.Column title="Source" dataIndex="source" key="source" />
								<Table.Column
									title="Total tokens"
									dataIndex="total_tokens"
									key="total_tokens"
									align="right"
									render={fmtTokens}
								/>
								<Table.Column
									title="Calls"
									dataIndex="calls"
									key="calls"
									align="right"
									render={fmtTokens}
								/>
								<Table.Column
									title="Cost"
									dataIndex="cost_usd"
									key="cost_usd"
									align="right"
									render={fmtUsd}
								/>
							</Table>
						</div>
					</section>
				</div>
			</div>
		</PageContent>
	);
};

export default TokenUsage;
