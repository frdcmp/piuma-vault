import { useState } from "react";
import {
	useCreateMcpServer,
	useDeleteMcpServer,
	useMcpHealth,
	useMcpServers,
	useTestMcpServer,
	useUpdateMcpServer,
} from "../../../queries";
import {
	PvButton,
	PvCheckbox,
	PvModal,
	PvPanel,
	pvMessage,
} from "../../components/ui";

const TRANSPORTS = [
	{ id: "http", label: "HTTP (remote server)" },
	{ id: "stdio", label: "stdio (local process)" },
];

// Server names become tool prefixes (`mcp__{name}__{tool}`), so they must be
// slugs: a-z 0-9 - _, max 32 chars, and no "__" (it would break the parsing).
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const validName = (n) => NAME_RE.test(n) && !n.includes("__");

const blankForm = () => ({
	name: "",
	transport: "http",
	url: "",
	auth_token: "",
	command: "",
	args: "",
	envRows: [],
	timeout_secs: 30,
	enabled: true,
	cron_safe: false,
});

// Seed the edit form from a saved server; secrets stay blank (write-only —
// the server returns only `auth_token_set` and `env_keys`).
const formFromServer = (s) => ({
	name: s.name || "",
	transport: s.transport || "http",
	url: s.url || "",
	auth_token: "",
	command: s.command || "",
	args: (s.args || []).join("\n"),
	envRows: (s.env_keys || []).map((k) => ({ key: k, value: "" })),
	timeout_secs: s.timeout_secs ?? 30,
	enabled: !!s.enabled,
	cron_safe: !!s.cron_safe,
});

// "ok: 12 tool(s)" → ok · "error: …" → err · null → none (never checked).
const statusKind = (s) =>
	!s.last_status ? "none" : s.last_status.startsWith("ok:") ? "ok" : "err";

// Add/edit form. `server === null` means a brand-new draft.
const ServerForm = ({ server, onClose }) => {
	const isNew = !server;
	const [form, setForm] = useState(() =>
		server ? formFromServer(server) : blankForm(),
	);
	// env values are write-only, so a PUT only includes `env` (which replaces
	// the whole object) once the admin actually touches the rows.
	const [envDirty, setEnvDirty] = useState(false);

	const create = useCreateMcpServer();
	const update = useUpdateMcpServer();

	const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
	const setBool = (key) => (checked) =>
		setForm((f) => ({ ...f, [key]: checked }));

	const setEnvRow = (i, field) => (e) => {
		setEnvDirty(true);
		setForm((f) => {
			const rows = f.envRows.map((r, j) =>
				j === i ? { ...r, [field]: e.target.value } : r,
			);
			return { ...f, envRows: rows };
		});
	};
	const addEnvRow = () => {
		setEnvDirty(true);
		setForm((f) => ({ ...f, envRows: [...f.envRows, { key: "", value: "" }] }));
	};
	const removeEnvRow = (i) => {
		setEnvDirty(true);
		setForm((f) => ({
			...f,
			envRows: f.envRows.filter((_, j) => j !== i),
		}));
	};

	const buildPayload = () => {
		const p = {
			name: form.name.trim(),
			transport: form.transport,
			enabled: form.enabled,
			cron_safe: form.cron_safe,
			timeout_secs: Number(form.timeout_secs) || 30,
		};
		if (form.transport === "http") {
			p.url = form.url.trim();
			// Leave-blank-to-keep: only send the token when typed.
			if (form.auth_token.trim()) p.auth_token = form.auth_token.trim();
		} else {
			p.command = form.command.trim();
			p.args = form.args
				.split("\n")
				.map((a) => a.trim())
				.filter(Boolean);
			if (isNew || envDirty) {
				const env = {};
				for (const r of form.envRows) {
					if (r.key.trim()) env[r.key.trim()] = r.value;
				}
				p.env = env;
			}
		}
		return p;
	};

	const handleSave = async () => {
		const name = form.name.trim();
		if (!validName(name)) {
			pvMessage.error(
				'Name must be a slug: a-z 0-9 - _ (max 32 chars, no "__")',
			);
			return;
		}
		if (form.transport === "http" && !form.url.trim()) {
			pvMessage.error("URL is required for http transport");
			return;
		}
		if (form.transport === "stdio" && !form.command.trim()) {
			pvMessage.error("Command is required for stdio transport");
			return;
		}
		try {
			if (isNew) {
				await create.mutateAsync(buildPayload());
				pvMessage.success("Server added");
			} else {
				await update.mutateAsync({ id: server.id, ...buildPayload() });
				pvMessage.success("Server saved");
			}
			onClose();
		} catch (err) {
			pvMessage.error(err?.response?.data?.error || "Failed to save");
		}
	};

	const busy = create.isPending || update.isPending;

	return (
		<div className="vp-mcp-card">
			<div className="vp-row" style={{ gap: 12, flexWrap: "wrap" }}>
				<div
					className="vp-field"
					style={{ flex: "1 1 200px", marginBottom: 0 }}
				>
					<span className="vp-label">Name</span>
					<input
						className="vp-input"
						type="text"
						spellCheck={false}
						placeholder="github"
						value={form.name}
						onChange={set("name")}
					/>
					<span className="vp-muted vp-text" style={{ fontSize: 12 }}>
						Slug: a-z 0-9 - _ · max 32 chars · no "__" — becomes the tool prefix{" "}
						<code>mcp__{form.name.trim() || "{name}"}__…</code>
					</span>
				</div>
				<div
					className="vp-field"
					style={{ flex: "1 1 200px", marginBottom: 0 }}
				>
					<span className="vp-label">Transport</span>
					<select
						className="vp-input"
						value={form.transport}
						onChange={set("transport")}
					>
						{TRANSPORTS.map((t) => (
							<option key={t.id} value={t.id}>
								{t.label}
							</option>
						))}
					</select>
				</div>
			</div>

			{form.transport === "http" ? (
				<>
					<div className="vp-field" style={{ marginBottom: 0 }}>
						<span className="vp-label">URL</span>
						<input
							className="vp-input"
							type="text"
							spellCheck={false}
							placeholder="https://mcp.example.com/mcp"
							value={form.url}
							onChange={set("url")}
						/>
					</div>
					<div className="vp-field" style={{ marginBottom: 0 }}>
						<span className="vp-label">
							Auth Token{" "}
							{!isNew && server.auth_token_set ? (
								<span className="vp-tag vp-tag--green vp-svc-chip">set</span>
							) : (
								<span className="vp-muted vp-svc-chip">optional</span>
							)}
						</span>
						<input
							className="vp-input"
							type="password"
							autoComplete="new-password"
							placeholder={
								!isNew && server.auth_token_set ? "unchanged" : "not set"
							}
							value={form.auth_token}
							onChange={set("auth_token")}
						/>
						{!isNew && server.auth_token_set && (
							<span className="vp-muted vp-text" style={{ fontSize: 12 }}>
								Leave blank to keep the stored token.
							</span>
						)}
					</div>
				</>
			) : (
				<>
					<p
						className="vp-text"
						style={{ fontSize: 12, color: "var(--vp-accent-3)", margin: 0 }}
					>
						Runs a process inside the mcp-worker container — admin only, trust
						the package.
					</p>
					<div className="vp-row" style={{ gap: 12, flexWrap: "wrap" }}>
						<div
							className="vp-field"
							style={{ flex: "1 1 200px", marginBottom: 0 }}
						>
							<span className="vp-label">Command</span>
							<input
								className="vp-input"
								type="text"
								spellCheck={false}
								placeholder="bunx"
								value={form.command}
								onChange={set("command")}
							/>
						</div>
						<div
							className="vp-field"
							style={{ flex: "1 1 240px", marginBottom: 0 }}
						>
							<span className="vp-label">Args (one per line)</span>
							<textarea
								className="vp-input"
								rows={3}
								spellCheck={false}
								placeholder={"-y\n@modelcontextprotocol/server-fetch"}
								value={form.args}
								onChange={set("args")}
							/>
						</div>
					</div>
					<div className="vp-field" style={{ marginBottom: 0 }}>
						<span className="vp-label">Environment variables</span>
						{form.envRows.map((r, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
								key={i}
								className="vp-row"
								style={{ gap: 8, marginBottom: 8 }}
							>
								<input
									className="vp-input"
									type="text"
									spellCheck={false}
									autoComplete="off"
									placeholder="API_KEY"
									style={{ flex: "1 1 140px" }}
									value={r.key}
									onChange={setEnvRow(i, "key")}
								/>
								<input
									className="vp-input"
									type="password"
									autoComplete="new-password"
									placeholder={
										!isNew && !envDirty && r.value === ""
											? "unchanged"
											: "value"
									}
									style={{ flex: "2 1 200px" }}
									value={r.value}
									onChange={setEnvRow(i, "value")}
								/>
								<PvButton size="sm" onClick={() => removeEnvRow(i)}>
									✕
								</PvButton>
							</div>
						))}
						<div className="vp-row">
							<PvButton size="sm" onClick={addEnvRow}>
								＋ Add variable
							</PvButton>
						</div>
						{!isNew && (
							<span className="vp-muted vp-text" style={{ fontSize: 12 }}>
								Values are write-only. Editing any row re-sends the whole set —
								re-enter every value when changing env.
							</span>
						)}
					</div>
				</>
			)}

			<div className="vp-row" style={{ gap: 16, flexWrap: "wrap" }}>
				<div
					className="vp-field"
					style={{ flex: "0 1 140px", marginBottom: 0 }}
				>
					<span className="vp-label">Timeout (secs)</span>
					<input
						className="vp-input"
						type="number"
						min={1}
						value={form.timeout_secs}
						onChange={set("timeout_secs")}
					/>
				</div>
				<PvCheckbox
					checked={form.enabled}
					onChange={setBool("enabled")}
					label="Enabled"
				/>
				<PvCheckbox
					checked={form.cron_safe}
					onChange={setBool("cron_safe")}
					label="Cron-safe (usable by scheduled jobs)"
				/>
			</div>

			<div className="vp-row" style={{ gap: 8, marginTop: 4 }}>
				<PvButton variant="primary" onClick={handleSave} disabled={busy}>
					{busy ? "Saving…" : isNew ? "Add server" : "Save"}
				</PvButton>
				<PvButton size="sm" onClick={onClose}>
					Cancel
				</PvButton>
			</div>
		</div>
	);
};

// One saved server: status/info row with quick toggles, test, edit, delete.
const ServerRow = ({ server, onEdit, onDeleteRequest }) => {
	const update = useUpdateMcpServer();
	const test = useTestMcpServer();
	const [showTools, setShowTools] = useState(false);
	const [testResult, setTestResult] = useState(null);

	const kind = statusKind(server);
	const tools = server.tools || [];

	const toggle = (key) => async (checked) => {
		try {
			await update.mutateAsync({ id: server.id, [key]: checked });
		} catch (err) {
			pvMessage.error(err?.response?.data?.error || "Failed to update");
		}
	};

	const runTest = async () => {
		setTestResult(null);
		try {
			const r = await test.mutateAsync(server.id);
			setTestResult({ ok: true, message: `${r.count} tool(s) discovered` });
		} catch (err) {
			setTestResult({
				ok: false,
				message: err?.response?.data?.error || "Test failed",
			});
		}
	};

	return (
		<div className="vp-mcp-card">
			<div className="vp-row" style={{ gap: 10, flexWrap: "wrap" }}>
				<span
					className={`vp-mcp-dot is-${kind}`}
					title={server.last_status || "never checked"}
				/>
				<span className="vp-mcp-name">{server.name}</span>
				<span className="vp-tag vp-tag--blue">{server.transport}</span>
				{!server.enabled && <span className="vp-tag">disabled</span>}
				{server.cron_safe && (
					<span className="vp-tag vp-tag--accent">cron-safe</span>
				)}
				<span className="vp-mcp-target" title={server.url || server.command}>
					{server.transport === "http"
						? server.url
						: [server.command, ...(server.args || [])].join(" ")}
				</span>
			</div>

			<div className="vp-row" style={{ gap: 16, flexWrap: "wrap" }}>
				<PvCheckbox
					checked={server.enabled}
					onChange={toggle("enabled")}
					disabled={update.isPending}
					label="Enabled"
				/>
				<PvCheckbox
					checked={server.cron_safe}
					onChange={toggle("cron_safe")}
					disabled={update.isPending}
					label="Cron-safe"
				/>
				<PvButton
					size="sm"
					onClick={() => setShowTools((s) => !s)}
					disabled={tools.length === 0}
				>
					{tools.length} tool{tools.length === 1 ? "" : "s"}{" "}
					{tools.length > 0 && (showTools ? "▴" : "▾")}
				</PvButton>
				<PvButton size="sm" onClick={runTest} disabled={test.isPending}>
					{test.isPending ? "Testing…" : "Test"}
				</PvButton>
				<PvButton size="sm" onClick={() => onEdit(server)}>
					Edit
				</PvButton>
				<PvButton
					size="sm"
					variant="danger"
					onClick={() => onDeleteRequest(server)}
				>
					Delete
				</PvButton>
				{testResult && (
					<span
						className={`vp-svc-result ${testResult.ok ? "is-ok" : "is-err"}`}
						title={testResult.message}
					>
						{testResult.ok ? "✓" : "✕"} {testResult.message}
					</span>
				)}
			</div>

			{showTools && tools.length > 0 && (
				<div className="vp-mcp-tools">
					{tools.map((t) => (
						<code key={t} className="vp-mcp-tool">
							mcp__{server.name}__{t}
						</code>
					))}
				</div>
			)}
		</div>
	);
};

const McpServers = () => {
	const { data: servers = [], isLoading, error } = useMcpServers();
	const health = useMcpHealth();
	const del = useDeleteMcpServer();
	// null = closed · "new" = blank draft · a server object = editing it.
	const [editing, setEditing] = useState(null);
	const [pendingDelete, setPendingDelete] = useState(null);

	const workerDown = !!health.error;

	const confirmDelete = async () => {
		if (!pendingDelete) return;
		const srv = pendingDelete;
		setPendingDelete(null);
		try {
			await del.mutateAsync(srv.id);
			pvMessage.success("Server deleted");
		} catch (err) {
			pvMessage.error(err?.response?.data?.error || "Failed to delete");
		}
	};

	return (
		<PvPanel title="integrations · mcp">
			<p className="vp-card-desc" style={{ marginBottom: 16 }}>
				Connect Model Context Protocol servers. Each server's tools appear to
				the chat agent as{" "}
				<code>
					mcp__{"{name}"}__{"{tool}"}
				</code>
				.
			</p>

			{workerDown && (
				<p
					className="vp-text"
					style={{
						fontSize: 12,
						fontWeight: 700,
						color: "var(--vp-accent-3)",
						border: "2px dashed var(--vp-accent-3)",
						padding: "8px 12px",
						marginBottom: 16,
					}}
				>
					MCP worker not running — servers can be configured but not tested.
				</p>
			)}

			{isLoading && <p className="vp-muted vp-text">Loading…</p>}
			{error && (
				<p className="vp-text" style={{ color: "var(--vp-accent-3)" }}>
					Failed to load MCP servers.
				</p>
			)}

			<div className="vp-stack">
				{servers.map((s) =>
					editing && editing !== "new" && editing.id === s.id ? (
						<ServerForm
							key={s.id}
							server={s}
							onClose={() => setEditing(null)}
						/>
					) : (
						<ServerRow
							key={s.id}
							server={s}
							onEdit={setEditing}
							onDeleteRequest={setPendingDelete}
						/>
					),
				)}
				{editing === "new" && (
					<ServerForm server={null} onClose={() => setEditing(null)} />
				)}
			</div>

			{editing !== "new" && (
				<div className="vp-row" style={{ marginTop: 16 }}>
					<PvButton onClick={() => setEditing("new")}>＋ Add server</PvButton>
				</div>
			)}

			<PvModal
				open={!!pendingDelete}
				title="Delete MCP server?"
				danger
				confirmText="Delete"
				cancelText="Cancel"
				onConfirm={confirmDelete}
				onCancel={() => setPendingDelete(null)}
			>
				<p className="vp-text">
					This permanently removes <strong>{pendingDelete?.name}</strong> and
					its stored credentials, and its tools disappear from the agent. This
					cannot be undone.
				</p>
			</PvModal>
		</PvPanel>
	);
};

export default McpServers;
