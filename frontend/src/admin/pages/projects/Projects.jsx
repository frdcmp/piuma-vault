import {
	ArrowLeftOutlined,
	CheckCircleOutlined,
	ClockCircleOutlined,
	EditOutlined,
	TeamOutlined,
	UserOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import { Avatar, Segmented, Table, Tooltip } from "antd";
import { useNavigate } from "react-router-dom";
import { PageContent } from "../../components/layout/PageLayout";
import { PvButton, PvPanel } from "../../components/ui";
import "../../vault-pixel.css";
import "./projects.css";

/** Mini stat card — pixel vault style */
const StatCard = ({ label, value, subValue, icon, accent }) => (
	<div className="vp-stat" data-accent={accent}>
		<div className="vp-stat-head">
			<div>
				<span className="vp-stat-label">{label}</span>
				<span className="vp-stat-value">{value}</span>
			</div>
			<span className="vp-stat-icon">{icon}</span>
		</div>
		{subValue && <span className="vp-stat-sub">{subValue}</span>}
	</div>
);

const Projects = () => {
	const navigate = useNavigate();

	// Mock data for transcription/annotation projects
	const projectsData = [
		{
			key: "1",
			name: "Spanish Medical Transcription",
			status: "active",
			language: "Spanish (ES)",
			domain: "Medical",
			contact: "maria.garcia@vault.example.com",
			specializations: ["Cardiology", "Radiology", "General Medicine"],
			linguists: 5,
			totalFiles: 450,
			transcribed: 338,
			annotated: 285,
			qcPassed: 245,
			dueDate: "2026-02-28",
		},
		{
			key: "2",
			name: "Japanese Legal Documents",
			status: "active",
			language: "Japanese (JP)",
			domain: "Legal",
			contact: "yuki.tanaka@vault.example.com",
			specializations: ["Corporate Law", "Patents"],
			linguists: 3,
			totalFiles: 280,
			transcribed: 168,
			annotated: 142,
			qcPassed: 115,
			dueDate: "2026-03-15",
		},
		{
			key: "3",
			name: "French Tech Support Calls",
			status: "completed",
			language: "French (FR)",
			domain: "Technology",
			contact: "pierre.dubois@vault.example.com",
			specializations: ["Software", "Hardware", "Networking"],
			linguists: 4,
			totalFiles: 620,
			transcribed: 620,
			annotated: 620,
			qcPassed: 620,
			dueDate: "2026-01-20",
		},
		{
			key: "4",
			name: "Mandarin Interview Collection",
			status: "active",
			language: "Mandarin (CN)",
			domain: "Research",
			contact: "li.wei@vault.example.com",
			specializations: ["Social Sciences", "Demographics"],
			linguists: 6,
			totalFiles: 380,
			transcribed: 323,
			annotated: 290,
			qcPassed: 268,
			dueDate: "2026-02-10",
		},
		{
			key: "5",
			name: "German Automotive Training",
			status: "in-progress",
			language: "German (DE)",
			domain: "Automotive",
			contact: "hans.mueller@vault.example.com",
			specializations: ["Engineering", "Safety", "Electric Vehicles"],
			linguists: 4,
			totalFiles: 520,
			transcribed: 208,
			annotated: 156,
			qcPassed: 98,
			dueDate: "2026-04-30",
		},
		{
			key: "6",
			name: "Arabic News Broadcasting",
			status: "planning",
			language: "Arabic (AR)",
			domain: "Media",
			contact: "ahmed.hassan@vault.example.com",
			specializations: ["News", "Political", "Cultural"],
			linguists: 5,
			totalFiles: 750,
			transcribed: 113,
			annotated: 75,
			qcPassed: 45,
			dueDate: "2026-03-20",
		},
	];

	const stats = [
		{
			title: "Total Files",
			value: "3,000",
			icon: <TeamOutlined />,
			accent: "accent",
			change: "+250",
			changeType: "positive",
		},
		{
			title: "Transcribed",
			value: "1,770",
			icon: <CheckCircleOutlined />,
			accent: "green",
			change: "+185",
			changeType: "positive",
		},
		{
			title: "Pending Annotation",
			value: "202",
			icon: <ClockCircleOutlined />,
			accent: "accent",
			change: "+15",
			changeType: "positive",
		},
		{
			title: "QC Issues",
			value: "38",
			icon: <WarningOutlined />,
			accent: "red",
			change: "-5",
			changeType: "negative",
		},
	];

	const getStatusVariant = (status) => {
		switch (status) {
			case "active":
				return "green";
			case "completed":
				return "blue";
			case "in-progress":
				return "accent";
			case "planning":
				return "";
			default:
				return "";
		}
	};

	const getStatusText = (status) => {
		switch (status) {
			case "active":
				return "Active";
			case "completed":
				return "Completed";
			case "in-progress":
				return "In Progress";
			case "planning":
				return "Planning";
			default:
				return status;
		}
	};

	const columns = [
		{
			title: "Project Name",
			dataIndex: "name",
			key: "name",
			width: 220,
			render: (text, record) => (
				<div className="vp-stack" style={{ gap: 2 }}>
					<span className="vp-cell-strong">{text}</span>
					<span className="vp-cell-sub">{record.language}</span>
				</div>
			),
		},
		{
			title: "Status",
			dataIndex: "status",
			key: "status",
			width: 120,
			render: (status) => {
				const variant = getStatusVariant(status);
				return (
					<span className={`vp-tag ${variant ? `vp-tag--${variant}` : ""}`}>
						{getStatusText(status)}
					</span>
				);
			},
		},
		{
			title: "Domain",
			dataIndex: "domain",
			key: "domain",
			width: 120,
			render: (text) => <span className="vp-tag vp-tag--blue">{text}</span>,
		},
		{
			title: "Files",
			dataIndex: "totalFiles",
			key: "totalFiles",
			width: 100,
			align: "center",
			render: (total) => (
				<div className="vp-stack vp-cell-center" style={{ gap: 2 }}>
					<span className="vp-cell-strong">{total}</span>
					<span className="vp-cell-sub">total</span>
				</div>
			),
		},
		{
			title: "Transcribed",
			dataIndex: "transcribed",
			key: "transcribed",
			width: 110,
			align: "center",
			render: (transcribed, record) => (
				<div className="vp-stack vp-cell-center" style={{ gap: 2 }}>
					<span className="vp-cell-strong vp-cell-green">{transcribed}</span>
					<span className="vp-cell-sub">
						{Math.round((transcribed / record.totalFiles) * 100)}%
					</span>
				</div>
			),
		},
		{
			title: "Annotated",
			dataIndex: "annotated",
			key: "annotated",
			width: 110,
			align: "center",
			render: (annotated, record) => (
				<div className="vp-stack vp-cell-center" style={{ gap: 2 }}>
					<span className="vp-cell-strong vp-cell-accent">{annotated}</span>
					<span className="vp-cell-sub">
						{Math.round((annotated / record.totalFiles) * 100)}%
					</span>
				</div>
			),
		},
		{
			title: "QC Passed",
			dataIndex: "qcPassed",
			key: "qcPassed",
			width: 110,
			align: "center",
			render: (qcPassed, record) => (
				<div className="vp-stack vp-cell-center" style={{ gap: 2 }}>
					<span className="vp-cell-strong vp-cell-blue">{qcPassed}</span>
					<span className="vp-cell-sub">
						{Math.round((qcPassed / record.totalFiles) * 100)}%
					</span>
				</div>
			),
		},
		{
			title: "Specializations",
			dataIndex: "specializations",
			key: "specializations",
			width: 200,
			render: (specs) => (
				<div className="vp-row vp-row--wrap" style={{ gap: 4 }}>
					{specs.slice(0, 2).map((spec) => (
						<span key={spec} className="vp-tag vp-tag--accent">
							{spec}
						</span>
					))}
					{specs.length > 2 && (
						<Tooltip title={specs.slice(2).join(", ")}>
							<span className="vp-tag">+{specs.length - 2}</span>
						</Tooltip>
					)}
				</div>
			),
		},
		{
			title: "Linguists",
			dataIndex: "linguists",
			key: "linguists",
			width: 110,
			align: "center",
			render: (linguists, record) => (
				<Avatar.Group max={{ count: 3 }}>
					{[...Array(linguists)].map((_, i) => (
						<Tooltip
							// biome-ignore lint/suspicious/noArrayIndexKey: placeholder linguist avatars have no stable id
							key={`${record.key}-linguist-${i}`}
							title={`Linguist ${i + 1}`}
						>
							<Avatar className="vp-linguist-avatar">
								{String.fromCharCode(65 + i)}
							</Avatar>
						</Tooltip>
					))}
				</Avatar.Group>
			),
		},
		{
			title: "Actions",
			key: "actions",
			width: 100,
			align: "center",
			render: () => (
				<PvButton
					size="sm"
					variant="accent"
					icon={<EditOutlined />}
					aria-label="Edit project"
				/>
			),
		},
	];

	return (
		<PageContent>
			<div className="vp-projects">
				{/* Header */}
				<header className="vp-page-head">
					<div>
						<h1 className="vp-page-title">Projects</h1>
						<p className="vp-page-subtitle">
							Manage ASR transcription projects and their batches
						</p>
					</div>
					<div className="vp-row vp-row--wrap">
						<span className="vp-page-meta">
							Last updated: March 4, 2026 | Total projects:{" "}
							{projectsData.length} | Active:{" "}
							{projectsData.filter((p) => p.status === "active").length}
						</span>
						<Segmented
							value="all"
							options={[
								{ label: "All Projects", value: "all" },
								{
									label: "My Projects",
									value: "mine",
									icon: <UserOutlined />,
								},
							]}
						/>
						<PvButton
							icon={<ArrowLeftOutlined />}
							onClick={() => navigate(-1)}
						>
							Back
						</PvButton>
					</div>
				</header>

				{/* Stats Cards */}
				<div className="vp-stats-grid">
					{stats.map((stat) => (
						<StatCard
							key={stat.title}
							label={stat.title}
							value={stat.value}
							subValue={stat.change}
							icon={stat.icon}
							accent={stat.accent}
						/>
					))}
				</div>

				{/* Projects Table */}
				<PvPanel
					title="All Projects"
					extra={
						<span className="vp-panel-count">
							{projectsData.length} projects
						</span>
					}
					noPad
				>
					<Table
						className="vp-table"
						dataSource={projectsData}
						columns={columns}
						pagination={{
							pageSize: 10,
							showSizeChanger: true,
							showTotal: (total) => `Total ${total} projects`,
							style: { marginRight: 20 },
						}}
						scroll={{ x: 1200 }}
					/>
				</PvPanel>
			</div>
		</PageContent>
	);
};

export default Projects;
