import {
	ApiOutlined,
	CloudOutlined,
	DatabaseOutlined,
	DockerOutlined,
	FileTextOutlined,
	SafetyOutlined,
	SearchOutlined,
	ShareAltOutlined,
	ThunderboltOutlined,
} from "@ant-design/icons";
import { PageContent } from "../../components/layout/PageLayout";
import { PvPanel } from "../../components/ui";
import "../../vault-pixel.css";
import "./about.css";

const ARCHITECTURE = [
	{
		icon: <FileTextOutlined />,
		title: "Frontend",
		body: "React 19 + Vite + Ant Design. The vault (notes) is served at the app root /; admin tools live under /admin. Built to frontend/dist and served by Nginx.",
	},
	{
		icon: <ThunderboltOutlined />,
		title: "Backend",
		body: "Rust + Actix-web with sqlx (compile-time-checked SQL, no ORM). Nginx adds the /api/v1 prefix at the edge; routes register relative.",
	},
	{
		icon: <DatabaseOutlined />,
		title: "Database",
		body: "PostgreSQL 15 with pgvector (1536-dim embeddings), pg_trgm and uuid-ossp. Tables are created on boot by a create-if-not-exists init step.",
	},
	{
		icon: <SearchOutlined />,
		title: "Embedding worker",
		body: "A separate binary polls the embedding_jobs queue (FOR UPDATE SKIP LOCKED), calls Azure OpenAI for vectors, and stores them on notes for vector search.",
	},
	{
		icon: <CloudOutlined />,
		title: "Storage",
		body: "Note attachments live on a Bunny S3-compatible CDN. The browser uploads/downloads via short-lived signed URLs — bytes never round-trip the backend.",
	},
	{
		icon: <DockerOutlined />,
		title: "Orchestration",
		body: "Docker Compose: piuma-vault-nginx, -rust, -embedding-worker, -db. Profiles: server-stack (nginx + rust + worker) and db-stack (postgres).",
	},
];

const APPS = [
	{
		name: "auth",
		desc: "JWT (RS256), refresh tokens, TOTP 2FA, trusted devices",
	},
	{
		name: "notes",
		desc: "CRUD, folders, tags, hybrid search, SSE live updates",
	},
	{
		name: "shares",
		desc: "Public note links with password / expiry / edit mode",
	},
	{ name: "storage", desc: "Bunny CDN attachments + signed URLs" },
	{ name: "agents", desc: "Multi-provider LLM chat, tools, layered memory" },
	{ name: "api_keys", desc: "Scoped x-api-key auth for programmatic access" },
	{ name: "email", desc: "SMTP for verification & password reset" },
	{ name: "health", desc: "Liveness / readiness checks" },
];

const COMMAND_BLOCKS = [
	{
		key: "compose",
		label: "Docker Compose",
		code: `# Full stack (nginx + rust + worker + db)
docker compose --profile server-stack --profile db-stack up -d

# Tail backend logs
docker compose logs -f rust

# Frontend dev (outside the container)
cd frontend && bun run dev`,
	},
	{
		key: "db",
		label: "Database",
		code: `# Local Postgres container: db_piuma-vault on host port 5500
PGPASSWORD=*** psql -h localhost -p 5500 -U user -d db_piuma-vault -c "SELECT count(*) FROM notes;"`,
	},
	{
		key: "checks",
		label: "Build & checks",
		code: `# Rust (hot-reloads under cargo watch — don't full build)
cd rust && cargo check

# Frontend
cd frontend && bun run build
cd frontend && bunx biome check --write src`,
	},
];

const About = () => {
	return (
		<PageContent>
			{/* Intro */}
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">About Piuma Vault</h1>
					<p className="vp-page-subtitle">
						Feather-light, self-hosted notes — on a lean Rust + React stack.
					</p>
				</div>
			</div>

			<div className="vp-stack">
				<div>
					<p className="vp-text vp-about-lead">
						<strong className="vp-accent">Piuma Vault</strong> ("piuma" =
						feather) is a feather-light, self-hosted notes vault: Markdown notes
						with hybrid full-text &amp; vector search, shareable links, and
						CDN-backed file storage — on a lean Rust + React stack.
					</p>
					<div className="vp-row vp-row--wrap vp-about-tags">
						<span className="vp-tag vp-tag--blue">React 19</span>
						<span className="vp-tag vp-tag--accent">Rust / Actix-web</span>
						<span className="vp-tag vp-tag--blue">PostgreSQL + pgvector</span>
						<span className="vp-tag vp-tag--green">Nginx</span>
						<span className="vp-tag vp-tag--green">Bunny CDN</span>
					</div>
				</div>

				<hr className="vp-divider" />

				{/* Architecture */}
				<div>
					<h2 className="vp-h2">Architecture</h2>
					<div className="vp-grid">
						{ARCHITECTURE.map((a) => (
							<div className="vp-card" key={a.title}>
								<div className="vp-row vp-about-card-head">
									<span className="vp-about-icon">{a.icon}</span>
									<h3 className="vp-card-title vp-about-card-title">
										{a.title}
									</h3>
								</div>
								<p className="vp-card-desc">{a.body}</p>
							</div>
						))}
					</div>
				</div>

				{/* Backend modules */}
				<div>
					<h2 className="vp-h2">Backend modules</h2>
					<div className="vp-about-modules">
						{APPS.map((app) => (
							<div className="vp-card vp-about-module" key={app.name}>
								<span className="vp-tag vp-tag--accent vp-about-module-tag">
									{app.name}
								</span>
								<span className="vp-card-desc">{app.desc}</span>
							</div>
						))}
					</div>
				</div>

				{/* Auth & access */}
				<div>
					<h2 className="vp-h2">
						<SafetyOutlined className="vp-about-h2-icon" />
						Authentication &amp; access
					</h2>
					<p className="vp-text vp-muted">
						Every protected route resolves an{" "}
						<code className="vp-about-code">AuthenticatedUser</code> from either
						a JWT Bearer token (browser login) or an{" "}
						<code className="vp-about-code">x-api-key</code> header (third-party
						/ scripts). Keys carry string permissions, checked per endpoint:
					</p>
					<div className="vp-row vp-row--wrap vp-about-tags">
						<span className="vp-tag vp-tag--blue">
							<ApiOutlined /> notes.read
						</span>
						<span className="vp-tag vp-tag--green">
							<ApiOutlined /> notes.write
						</span>
						<span className="vp-tag vp-tag--blue">
							<ApiOutlined /> storage.access
						</span>
						<span className="vp-tag vp-tag--accent">admin_access</span>
					</div>
					<div className="vp-about-alert">
						<span className="vp-about-alert-icon">
							<SafetyOutlined />
						</span>
						<div>
							<p className="vp-about-alert-title">API keys are per-database</p>
							<p className="vp-about-alert-desc">
								An x-api-key only works against the database that holds its
								hashed row. Migrating to a new DB requires migrating the
								api_keys table too.
							</p>
						</div>
					</div>
				</div>

				{/* Running locally */}
				<div>
					<h2 className="vp-h2">Running locally</h2>
					<div className="vp-stack">
						{COMMAND_BLOCKS.map((block) => (
							<PvPanel title={block.label} key={block.key}>
								<pre className="vp-about-codeblock">{block.code}</pre>
							</PvPanel>
						))}
					</div>
				</div>

				<hr className="vp-divider" />
				<p className="vp-about-footer">
					<ShareAltOutlined /> Piuma Vault · feather-light notes, self-hosted.
				</p>
			</div>
		</PageContent>
	);
};

export default About;
