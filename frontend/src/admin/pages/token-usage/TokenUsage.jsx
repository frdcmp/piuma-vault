import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
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
import { PvButton, PvDateTimePicker, PvPanel, PvSelect, PvTable } from "@/ui";
import { useTokenUsage } from "../../../queries";
import { useTheme } from "../../../theme";
import { PageContent } from "../../components/layout/PageLayout";
import "./token-usage.css";

const SOURCE_OPTIONS = [
	{ value: "chat", label: "Chat" },
	{ value: "voice", label: "Voice" },
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
// A bucket's cost; voice usage without a rate card (Services → Voice) is
// flagged rather than shown as a misleading $0.
const fmtCost = (v, row) => {
	if (!row?.unpriced) return fmtUsd(v);
	return v ? `${fmtUsd(v)} + unpriced` : "unpriced";
};
// Audio subset of a bucket's input / output (voice); "—" when there is none.
const fmtAudio = (_, row) =>
	row.tokens_input_audio || row.tokens_output_audio
		? `${fmtTokens(row.tokens_input_audio)} / ${fmtTokens(row.tokens_output_audio)}`
		: "—";
// Rate-card prices (USD per 1M tokens). Two decimals normally; keep more for
// sub-cent rates like DeepSeek's $0.0028/M cache reads so they don't show $0.00.
const fmtPrice = (n) => {
	const v = n || 0;
	if (v === 0) return "—";
	if (v >= 0.01) return `$${v.toFixed(2)}`;
	return `$${v.toFixed(4)}`;
};

// Blend two "#rrggbb" colours: `t` = weight of `a` (0..1). SVG `stroke` /
// `fill` attributes can't resolve CSS vars or color-mix(), so chart colours are
// computed from the theme tokens in JS.
const mixHex = (a, b, t) => {
	const ch = (hex, i) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
	return `#${[0, 1, 2]
		.map((i) =>
			Math.round(ch(a, i) * t + ch(b, i) * (1 - t))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
};

const MODEL_COLUMNS = [
	{ title: "Model", dataIndex: "model", key: "model" },
	{
		title: "Provider",
		dataIndex: "provider_kind",
		key: "provider_kind",
		render: (v) => v || "—",
	},
	{
		title: "Input",
		dataIndex: "tokens_input",
		key: "tokens_input",
		align: "right",
		render: fmtTokens,
	},
	{
		title: "Output",
		dataIndex: "tokens_output",
		key: "tokens_output",
		align: "right",
		render: fmtTokens,
	},
	{
		title: "Cached",
		dataIndex: "tokens_cached",
		key: "tokens_cached",
		align: "right",
		render: fmtTokens,
	},
	{ title: "Audio in / out", key: "audio", align: "right", render: fmtAudio },
	{
		title: "Calls",
		dataIndex: "calls",
		key: "calls",
		align: "right",
		render: fmtTokens,
	},
	{
		title: "Cost",
		dataIndex: "cost_usd",
		key: "cost_usd",
		align: "right",
		render: fmtCost,
	},
];

const SOURCE_COLUMNS = [
	{ title: "Source", dataIndex: "source", key: "source" },
	{
		title: "Total tokens",
		dataIndex: "total_tokens",
		key: "total_tokens",
		align: "right",
		render: fmtTokens,
	},
	{
		title: "Calls",
		dataIndex: "calls",
		key: "calls",
		align: "right",
		render: fmtTokens,
	},
	{
		title: "Cost",
		dataIndex: "cost_usd",
		key: "cost_usd",
		align: "right",
		render: fmtCost,
	},
];

const PRICING_COLUMNS = [
	{ title: "Model", dataIndex: "model", key: "model" },
	{
		title: "Provider",
		dataIndex: "provider_kind",
		key: "provider_kind",
		render: (v) => v || "—",
	},
	{
		title: "Input",
		dataIndex: "price_input",
		key: "price_input",
		align: "right",
		render: fmtPrice,
	},
	{
		title: "Output",
		dataIndex: "price_output",
		key: "price_output",
		align: "right",
		render: fmtPrice,
	},
	{
		title: "Cached",
		dataIndex: "price_cached",
		key: "price_cached",
		align: "right",
		render: fmtPrice,
	},
	{
		title: "Audio in",
		dataIndex: "price_audio_input",
		key: "price_audio_input",
		align: "right",
		render: fmtPrice,
	},
	{
		title: "Audio out",
		dataIndex: "price_audio_output",
		key: "price_audio_output",
		align: "right",
		render: fmtPrice,
	},
];

const TOOLTIP_STYLE = {
	background: "var(--vp-panel)",
	border: "2px solid var(--vp-border)",
	borderRadius: 0,
	fontFamily: "var(--vp-font)",
};
const TOOLTIP_LABEL_STYLE = { color: "var(--vp-text)" };
// Recharts colours legend text with the series colour (inline) by default.
const LEGEND_LABEL_STYLE = { color: "var(--vp-text)" };

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
	const { tokens } = useTheme();
	const SERIES = {
		input: tokens.info,
		cached: mixHex(tokens.info, tokens.bg, 0.5), // dim blue
		output: tokens.success,
		cost: tokens.accent,
	};
	const AXIS = tokens.muted;
	const GRID = tokens.borderSoft;
	// Day pickers emit UTC ISO strings of local midnight; null = open-ended.
	const [from, setFrom] = useState(null);
	const [to, setTo] = useState(null);
	const [source, setSource] = useState(undefined);

	const params = useMemo(() => {
		const p = {};
		if (from) p.from = dayjs(from).format("YYYY-MM-DD");
		if (to) p.to = dayjs(to).add(1, "day").format("YYYY-MM-DD"); // `to` is exclusive
		if (source) p.source = source;
		return p;
	}, [from, to, source]);

	const { data, isLoading, refetch, isFetching } = useTokenUsage(params);

	const summary = data?.summary || {};
	const byModel = data?.by_model || [];
	const bySource = data?.by_source || [];
	const byDay = data?.by_day || [];
	const pricing = data?.pricing || [];

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
							Spend and token volume per model, source, and over time — chat,
							voice and embeddings.
						</p>
					</div>
					<div className="vp-row vp-row--wrap">
						<div className="vp-row tu-range">
							<PvDateTimePicker
								mode="date"
								value={from}
								onChange={setFrom}
								placeholder="Start date"
							/>
							<span className="vp-muted">→</span>
							<PvDateTimePicker
								mode="date"
								value={to}
								onChange={setTo}
								placeholder="End date"
							/>
						</div>
						<PvSelect
							allowClear
							placeholder="All sources"
							className="tu-source"
							value={source}
							onChange={setSource}
							options={SOURCE_OPTIONS}
							aria-label="Source"
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
							value={fmtCost(summary.cost_usd, summary)}
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
					<PvPanel title="Usage over time" bodyClassName="tu-chart">
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
									contentStyle={TOOLTIP_STYLE}
									labelStyle={TOOLTIP_LABEL_STYLE}
								/>
								<Legend labelStyle={LEGEND_LABEL_STYLE} />
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
					</PvPanel>

					{/* Per-model bar chart */}
					<PvPanel title="Tokens per model" bodyClassName="tu-chart">
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
									cursor={{ fill: tokens.highlight, fillOpacity: 0.04 }}
									contentStyle={TOOLTIP_STYLE}
									labelStyle={TOOLTIP_LABEL_STYLE}
								/>
								<Legend labelStyle={LEGEND_LABEL_STYLE} />
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
					</PvPanel>

					{/* Per-model table */}
					<PvPanel title="By model">
						<PvTable
							columns={MODEL_COLUMNS}
							data={byModel}
							rowKey="model"
							loading={isLoading}
							size="sm"
							minWidth={840}
						/>
					</PvPanel>

					{/* Per-source table */}
					<PvPanel title="By source">
						<PvTable
							columns={SOURCE_COLUMNS}
							data={bySource}
							rowKey="source"
							loading={isLoading}
							size="sm"
							minWidth={600}
						/>
					</PvPanel>

					{/* Rate card — configured price per 1M tokens for each model */}
					<PvPanel title="Model pricing ($ / 1M tokens)">
						<PvTable
							columns={PRICING_COLUMNS}
							data={pricing}
							rowKey={(r) => `${r.provider_kind}:${r.model}`}
							loading={isLoading}
							size="sm"
							minWidth={600}
						/>
						<p className="vp-muted tu-note">
							Prices are editable per model in the Agents page; voice
							(speech-to- speech) prices in Services → Voice, where input/output
							are the text rates and audio bills separately. “—” means no price
							set (local models bill at $0).
						</p>
					</PvPanel>
				</div>
			</div>
		</PageContent>
	);
};

export default TokenUsage;
