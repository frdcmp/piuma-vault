import {
	CheckCircleOutlined,
	CloseCircleOutlined,
	CodeOutlined,
	LoadingOutlined,
	SyncOutlined,
} from "@ant-design/icons";
import { Spin } from "antd";
import { useGetHello } from "../../../queries";
import { PageContent } from "../../components/layout/PageLayout";
import { PvPanel } from "../../components/ui";
import "../../vault-pixel.css";
import "./apiTest.css";

const METHOD_TAG_CLASSES = {
	GET: "vp-tag--blue",
	POST: "vp-tag--green",
	PUT: "vp-tag--accent",
	DELETE: "vp-tag--red",
};

const StatusTag = ({ status }) => {
	switch (status) {
		case "active":
			return <span className="vp-tag vp-tag--green">Active</span>;
		case "loading":
			return <span className="vp-tag vp-tag--blue">Loading</span>;
		case "error":
			return <span className="vp-tag vp-tag--red">Error</span>;
		default:
			return <span className="vp-tag">Unknown</span>;
	}
};

const ApiTest = () => {
	const { data: helloMessage, isLoading: loading, isError } = useGetHello();

	const apiEndpoints = [
		{
			name: "Health Check",
			method: "GET",
			endpoint: "/api/v1/health",
			status: "active",
			description: "Check if the API is running",
		},
		{
			name: "Hello World",
			method: "GET",
			endpoint: "/api/v1/hello",
			status: loading ? "loading" : isError ? "error" : "active",
			description: "Get a hello message from the backend",
		},
		{
			name: "Authentication",
			method: "POST",
			endpoint: "/api/v1/auth/login",
			status: "active",
			description: "User authentication endpoint",
		},
		{
			name: "User Profile",
			method: "GET",
			endpoint: "/api/v1/user/me",
			status: "active",
			description: "Get current user information",
		},
	];

	const responseTag = loading ? (
		<span className="vp-tag vp-tag--blue">
			<LoadingOutlined /> Loading
		</span>
	) : isError ? (
		<span className="vp-tag vp-tag--red">
			<CloseCircleOutlined /> Failed
		</span>
	) : (
		<span className="vp-tag vp-tag--green">
			<CheckCircleOutlined /> Success
		</span>
	);

	return (
		<PageContent>
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">API Testing</h1>
					<p className="vp-page-subtitle">
						Test and monitor your backend API endpoints in real-time
					</p>
				</div>
			</div>

			{/* Live API Response */}
			<PvPanel
				title={
					<span className="vp-test-panel-title">
						<SyncOutlined spin={loading} /> Live API Response
					</span>
				}
				extra={responseTag}
				className="vp-test-response-panel"
			>
				{loading ? (
					<div className="vp-test-loading">
						<Spin size="large" />
						<p className="vp-muted vp-test-loading-text">
							Fetching data from backend...
						</p>
					</div>
				) : isError ? (
					<div className="vp-test-alert vp-test-alert--error">
						<CloseCircleOutlined className="vp-test-alert-icon" />
						<div>
							<strong className="vp-test-alert-title">
								API Request Failed
							</strong>
							<p className="vp-test-alert-desc">
								Unable to connect to the backend API. Please ensure the server
								is running.
							</p>
						</div>
					</div>
				) : (
					<div className="vp-stack">
						<div className="vp-test-alert vp-test-alert--success">
							<CheckCircleOutlined className="vp-test-alert-icon" />
							<div>
								<strong className="vp-test-alert-title">
									Connection Successful
								</strong>
								<p className="vp-test-alert-desc">
									Successfully connected to the backend API
								</p>
							</div>
						</div>
						<dl className="vp-test-descriptions">
							<div className="vp-test-desc-row">
								<dt>Response Message</dt>
								<dd className="vp-accent">
									{helloMessage?.message || helloMessage || "No message"}
								</dd>
							</div>
							<div className="vp-test-desc-row">
								<dt>Status Code</dt>
								<dd>
									<span className="vp-tag vp-tag--green">200 OK</span>
								</dd>
							</div>
							<div className="vp-test-desc-row">
								<dt>Endpoint</dt>
								<dd>
									<code className="vp-test-code">/api/v1/hello</code>
								</dd>
							</div>
						</dl>
					</div>
				)}
			</PvPanel>

			{/* Endpoints */}
			<div className="vp-test-section-head">
				<h2 className="vp-h2">Available Endpoints</h2>
			</div>
			<div className="vp-grid">
				{apiEndpoints.map((endpoint) => (
					<div className="vp-card" key={endpoint.endpoint}>
						<div className="vp-row vp-spread vp-test-card-head">
							<span
								className={`vp-tag ${METHOD_TAG_CLASSES[endpoint.method] || ""}`.trim()}
							>
								{endpoint.method}
							</span>
							<StatusTag status={endpoint.status} />
						</div>
						<h3 className="vp-card-title">{endpoint.name}</h3>
						<code className="vp-test-code vp-test-card-endpoint">
							{endpoint.endpoint}
						</code>
						<p className="vp-card-desc">{endpoint.description}</p>
					</div>
				))}
			</div>

			{/* Info Section */}
			<PvPanel title="backend.info" className="vp-test-info-panel">
				<div className="vp-test-info">
					<CodeOutlined className="vp-test-info-icon" />
					<h3 className="vp-h2">Rust Backend + React Frontend</h3>
					<p className="vp-test-info-text">
						This page demonstrates real-time API communication between your
						React frontend and Rust backend using TanStack Query for efficient
						data fetching and caching.
					</p>
				</div>
			</PvPanel>
		</PageContent>
	);
};

export default ApiTest;
