import { useEffect, useState } from "react";
import {
	useAgentList,
	useAgentPersonas,
	useAgentProfile,
	useCreateModel,
	useCreateProvider,
	useDefaultAgent,
	useDeleteModel,
	useDeleteProvider,
	useModels,
	useProviders,
	useSetDefaultAgent,
	useUpdateAgentProfile,
	useUpdateModel,
	useUpdatePersona,
} from "../../../queries";
import "./agents.css";

const PROVIDER_KINDS = ["deepseek", "anthropic", "openai", "gemini", "minimax"];

const errMsg = (e, fallback) =>
	e?.response?.data?.error || e?.message || fallback;

// ── Providers + models ───────────────────────────────────────────────────────

function ModelsList({ providerId }) {
	const { data: models = [] } = useModels(providerId);
	const createModel = useCreateModel();
	const updateModel = useUpdateModel();
	const deleteModel = useDeleteModel();
	const [modelId, setModelId] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [thinking, setThinking] = useState(true);
	const [error, setError] = useState("");

	const add = async () => {
		if (!modelId.trim() || !displayName.trim()) return;
		setError("");
		try {
			await createModel.mutateAsync({
				providerId,
				model_id: modelId.trim(),
				display_name: displayName.trim(),
				supports_thinking: thinking,
			});
			setModelId("");
			setDisplayName("");
		} catch (e) {
			setError(errMsg(e, "Failed to add model"));
		}
	};

	return (
		<div>
			{models.map((m) => (
				<div key={m.id} className="ag-row" style={{ padding: "4px 0" }}>
					<button
						type="button"
						className="ag-btn--icon"
						title={m.is_default ? "Default model" : "Set as default"}
						onClick={() => updateModel.mutate({ id: m.id, is_default: true })}
						style={{ color: m.is_default ? "#f7c948" : undefined }}
					>
						{m.is_default ? "★" : "☆"}
					</button>
					<strong>{m.display_name}</strong>
					<span className="ag-muted">{m.model_id}</span>
					{m.supports_thinking && (
						<span className="ag-tag ag-tag--purple">thinking</span>
					)}
					<button
						type="button"
						className="ag-btn--icon ag-btn--danger"
						title="Delete model"
						onClick={() => {
							if (window.confirm("Delete this model?"))
								deleteModel.mutate(m.id);
						}}
					>
						✕
					</button>
				</div>
			))}
			<div className="ag-row" style={{ marginTop: 8 }}>
				<input
					className="ag-input"
					style={{ maxWidth: 200 }}
					placeholder="wire id (deepseek-chat)"
					value={modelId}
					onChange={(e) => setModelId(e.target.value)}
				/>
				<input
					className="ag-input"
					style={{ maxWidth: 200 }}
					placeholder="display name"
					value={displayName}
					onChange={(e) => setDisplayName(e.target.value)}
				/>
				<label className="ag-muted ag-row" style={{ gap: 4 }}>
					<input
						type="checkbox"
						checked={thinking}
						onChange={(e) => setThinking(e.target.checked)}
					/>
					thinking
				</label>
				<button type="button" className="ag-btn ag-btn--sm" onClick={add}>
					+ Add model
				</button>
			</div>
			{error && <div className="ag-error">{error}</div>}
		</div>
	);
}

function ProvidersTab() {
	const { data: providers = [] } = useProviders();
	const createProvider = useCreateProvider();
	const deleteProvider = useDeleteProvider();
	const [showForm, setShowForm] = useState(false);
	const [kind, setKind] = useState("deepseek");
	const [displayName, setDisplayName] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [error, setError] = useState("");

	const create = async () => {
		if (!displayName.trim() || !apiKey.trim()) {
			setError("Display name and API key are required");
			return;
		}
		setError("");
		try {
			await createProvider.mutateAsync({
				kind,
				display_name: displayName.trim(),
				api_key: apiKey.trim(),
				base_url: baseUrl.trim() || undefined,
			});
			setShowForm(false);
			setDisplayName("");
			setApiKey("");
			setBaseUrl("");
		} catch (e) {
			setError(errMsg(e, "Failed to add provider"));
		}
	};

	return (
		<div>
			<button
				type="button"
				className="ag-btn ag-btn--primary"
				onClick={() => setShowForm((s) => !s)}
			>
				{showForm ? "Cancel" : "+ Add provider"}
			</button>

			{showForm && (
				<div className="ag-card" style={{ marginTop: 12 }}>
					<div className="ag-card-body">
						<div className="ag-field">
							<span className="ag-label">Kind</span>
							<select
								className="ag-select"
								value={kind}
								onChange={(e) => setKind(e.target.value)}
							>
								{PROVIDER_KINDS.map((k) => (
									<option key={k} value={k}>
										{k}
									</option>
								))}
							</select>
						</div>
						<div className="ag-field">
							<span className="ag-label">Display name</span>
							<input
								className="ag-input"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="DeepSeek"
							/>
						</div>
						<div className="ag-field">
							<span className="ag-label">API key</span>
							<input
								className="ag-input"
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder="sk-…"
							/>
						</div>
						<div className="ag-field">
							<span className="ag-label">Base URL (optional)</span>
							<input
								className="ag-input"
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
								placeholder="https://api.deepseek.com"
							/>
						</div>
						{error && <div className="ag-error">{error}</div>}
						<button
							type="button"
							className="ag-btn ag-btn--primary"
							onClick={create}
							disabled={createProvider.isPending}
						>
							Save provider
						</button>
					</div>
				</div>
			)}

			{providers.length === 0 && !showForm && (
				<div className="ag-empty">
					No providers yet — add DeepSeek to start.
				</div>
			)}

			<div style={{ marginTop: 12 }}>
				{providers.map((p) => (
					<div key={p.id} className="ag-card">
						<div className="ag-card-head">
							<div className="ag-row">
								<strong>{p.display_name}</strong>
								<span className="ag-tag">{p.kind}</span>
								{p.has_key ? (
									<span className="ag-muted">key {p.api_key_masked}</span>
								) : (
									<span className="ag-tag ag-tag--red">no key</span>
								)}
							</div>
							<button
								type="button"
								className="ag-btn--icon ag-btn--danger"
								title="Delete provider"
								onClick={() => {
									if (window.confirm("Delete provider and its models?"))
										deleteProvider.mutate(p.id);
								}}
							>
								✕
							</button>
						</div>
						<div className="ag-card-body">
							<ModelsList providerId={p.id} />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ── Agent config ─────────────────────────────────────────────────────────────

function ConfigTab({ agent }) {
	const { data: profile } = useAgentProfile(agent);
	const { data: personas = [] } = useAgentPersonas(agent);
	const updateProfile = useUpdateAgentProfile();
	const updatePersona = useUpdatePersona();
	const persona = personas[0];

	const [pf, setPf] = useState({
		display_name: "",
		instructions: "",
		user_context: "",
		memory: "",
	});
	const [pe, setPe] = useState({
		display_name: "",
		emoji: "",
		system_prompt: "",
		allowed_tools: "",
	});
	const [status, setStatus] = useState("");
	const [commands, setCommands] = useState([]);

	useEffect(() => {
		if (profile) {
			setPf({
				display_name: profile.display_name || "",
				instructions: profile.instructions || "",
				user_context: profile.user_context || "",
				memory: profile.memory || "",
			});
			setCommands(Array.isArray(profile.commands) ? profile.commands : []);
		}
	}, [profile]);
	useEffect(() => {
		if (persona)
			setPe({
				display_name: persona.display_name || "",
				emoji: persona.emoji || "",
				system_prompt: persona.system_prompt || "",
				allowed_tools: (persona.allowed_tools || []).join(", "),
			});
	}, [persona]);

	const saveProfile = async () => {
		try {
			await updateProfile.mutateAsync({ agent, ...pf, commands });
			setStatus("Profile saved ✓");
		} catch {
			setStatus("Failed to save profile");
		}
	};
	const savePersona = async () => {
		const tools = pe.allowed_tools
			.split(/[,\n]/)
			.map((s) => s.trim())
			.filter(Boolean);
		try {
			await updatePersona.mutateAsync({
				id: persona.id,
				display_name: pe.display_name,
				emoji: pe.emoji,
				system_prompt: pe.system_prompt,
				allowed_tools: tools.length ? tools : null,
			});
			setStatus("Persona saved ✓");
		} catch {
			setStatus("Failed to save persona");
		}
	};

	return (
		<div>
			{status && (
				<div className="ag-muted" style={{ marginBottom: 8 }}>
					{status}
				</div>
			)}
			<div className="ag-cols">
				<div className="ag-col ag-card">
					<div className="ag-card-head">
						<strong>Agent profile</strong>
					</div>
					<div className="ag-card-body">
						<div className="ag-field">
							<span className="ag-label">Display name</span>
							<input
								className="ag-input"
								value={pf.display_name}
								onChange={(e) => setPf({ ...pf, display_name: e.target.value })}
							/>
						</div>
						<div className="ag-field">
							<span className="ag-label">Instructions (always loaded)</span>
							<textarea
								className="ag-textarea"
								rows={8}
								value={pf.instructions}
								onChange={(e) => setPf({ ...pf, instructions: e.target.value })}
							/>
						</div>
						<div className="ag-field">
							<span className="ag-label">User context</span>
							<textarea
								className="ag-textarea"
								rows={4}
								value={pf.user_context}
								onChange={(e) => setPf({ ...pf, user_context: e.target.value })}
							/>
						</div>
						<div className="ag-field">
							<span className="ag-label">Memory</span>
							<textarea
								className="ag-textarea"
								rows={4}
								value={pf.memory}
								onChange={(e) => setPf({ ...pf, memory: e.target.value })}
							/>
						</div>
						<div className="ag-field">
							<span className="ag-label">
								Slash commands (chat macros for this agent)
							</span>
							{commands.map((cmd, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and have no stable id
									key={`cmd-${i}`}
									className="ag-row"
									style={{ alignItems: "flex-start", marginBottom: 6 }}
								>
									<input
										className="ag-input"
										style={{ maxWidth: 120 }}
										placeholder="name"
										value={cmd.name || ""}
										onChange={(e) => {
											const next = [...commands];
											next[i] = { ...next[i], name: e.target.value };
											setCommands(next);
										}}
									/>
									<input
										className="ag-input"
										style={{ maxWidth: 160 }}
										placeholder="description"
										value={cmd.description || ""}
										onChange={(e) => {
											const next = [...commands];
											next[i] = { ...next[i], description: e.target.value };
											setCommands(next);
										}}
									/>
									<textarea
										className="ag-textarea"
										style={{ flex: 1 }}
										rows={1}
										placeholder="prompt sent when invoked"
										value={cmd.prompt || ""}
										onChange={(e) => {
											const next = [...commands];
											next[i] = { ...next[i], prompt: e.target.value };
											setCommands(next);
										}}
									/>
									<button
										type="button"
										className="ag-btn--icon ag-btn--danger"
										title="Remove command"
										onClick={() =>
											setCommands(commands.filter((_, j) => j !== i))
										}
									>
										✕
									</button>
								</div>
							))}
							<button
								type="button"
								className="ag-btn ag-btn--sm"
								onClick={() =>
									setCommands([
										...commands,
										{ name: "", description: "", prompt: "" },
									])
								}
							>
								+ Add command
							</button>
						</div>
						<button
							type="button"
							className="ag-btn ag-btn--primary"
							onClick={saveProfile}
						>
							Save profile
						</button>
					</div>
				</div>

				{persona && (
					<div className="ag-col ag-card">
						<div className="ag-card-head">
							<strong>Persona — {persona.display_name || persona.name}</strong>
						</div>
						<div className="ag-card-body">
							<div className="ag-row">
								<div className="ag-field" style={{ width: 90 }}>
									<span className="ag-label">Emoji</span>
									<input
										className="ag-input"
										value={pe.emoji}
										onChange={(e) => setPe({ ...pe, emoji: e.target.value })}
									/>
								</div>
								<div className="ag-field" style={{ flex: 1 }}>
									<span className="ag-label">Display name</span>
									<input
										className="ag-input"
										value={pe.display_name}
										onChange={(e) =>
											setPe({ ...pe, display_name: e.target.value })
										}
									/>
								</div>
							</div>
							<div className="ag-field">
								<span className="ag-label">
									System prompt (voice / who-I-am)
								</span>
								<textarea
									className="ag-textarea"
									rows={10}
									value={pe.system_prompt}
									onChange={(e) =>
										setPe({ ...pe, system_prompt: e.target.value })
									}
								/>
							</div>
							<div className="ag-field">
								<span className="ag-label">
									Allowed tools (comma-separated; empty = inherit all)
								</span>
								<textarea
									className="ag-textarea"
									rows={2}
									value={pe.allowed_tools}
									onChange={(e) =>
										setPe({ ...pe, allowed_tools: e.target.value })
									}
								/>
							</div>
							<button
								type="button"
								className="ag-btn ag-btn--primary"
								onClick={savePersona}
							>
								Save persona
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
	const { data: agents = [] } = useAgentList();
	const { data: def } = useDefaultAgent();
	const setDefault = useSetDefaultAgent();
	const agent = agents[0]?.kind || "vault_agent";
	const [tab, setTab] = useState("providers");

	return (
		<div className="ag-page">
			<h1 className="ag-title">Agents</h1>
			<p className="ag-sub">
				Multi-provider LLM setup. Add a provider + model and tune the agent's
				config. Chat lives in the main app (and mobile).
			</p>
			{agents.length > 0 && (
				<div className="ag-row" style={{ marginBottom: 16 }}>
					<span className="ag-muted">Default agent for new chats:</span>
					<select
						className="ag-select"
						style={{ width: 200 }}
						value={def?.agent || ""}
						onChange={(e) => setDefault.mutate(e.target.value)}
					>
						{agents.map((a) => (
							<option key={a.kind} value={a.kind}>
								{a.display_name}
							</option>
						))}
					</select>
				</div>
			)}
			<div className="ag-tabs">
				{[
					["providers", "Providers & models"],
					["config", "Agent config"],
				].map(([key, label]) => (
					<button
						type="button"
						key={key}
						className={`ag-tab ${tab === key ? "ag-tab--active" : ""}`}
						onClick={() => setTab(key)}
					>
						{label}
					</button>
				))}
			</div>
			{tab === "providers" && <ProvidersTab />}
			{tab === "config" && <ConfigTab agent={agent} />}
		</div>
	);
}
