import { useEffect, useState } from "react";
import { fetchModelMeta } from "../../../api/agentChatApi";
import {
	useAgentList,
	useAgentPersonas,
	useAgentProfile,
	useAvailableModels,
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
import { PvCheckbox, PvModal } from "../../components/ui";
import "./agents.css";

const PROVIDER_KINDS = [
	"deepseek",
	"anthropic",
	"openai",
	"gemini",
	"minimax",
	"ollama",
	"lmstudio",
];

// Friendlier labels for the kind dropdown.
const KIND_LABEL = {
	ollama: "Ollama (local)",
	lmstudio: "LM Studio (local)",
};

// Local, OpenAI-compatible runtimes: no API key required, and we pre-fill the
// intuitive localhost URL. The backend rewrites localhost → the docker host
// gateway when it calls out, so this just works. URL includes the `/v1` path.
const LOCAL_KINDS = new Set(["ollama", "lmstudio"]);
const DEFAULT_BASE_URL = {
	ollama: "http://localhost:11434/v1",
	lmstudio: "http://localhost:1234/v1",
};

const errMsg = (e, fallback) =>
	e?.response?.data?.error || e?.message || fallback;

// ── Providers + models ───────────────────────────────────────────────────────

function ModelsList({ providerId, providerKind }) {
	const { data: models = [] } = useModels(providerId);
	const createModel = useCreateModel();
	const updateModel = useUpdateModel();
	const deleteModel = useDeleteModel();
	const [modelId, setModelId] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [thinking, setThinking] = useState(true);
	const [vision, setVision] = useState(false);
	// Context window auto-detected from Ollama /api/show (null = leave to default).
	const [ctxWindow, setCtxWindow] = useState(null);
	const [error, setError] = useState("");
	const [pendingDelete, setPendingDelete] = useState(null);
	const [picker, setPicker] = useState(false);
	// Model being priced (USD per 1M tokens) + the editable values.
	const [pricing, setPricing] = useState(null);
	const [priceIn, setPriceIn] = useState(0);
	const [priceOut, setPriceOut] = useState(0);
	const [priceCached, setPriceCached] = useState(0);

	const openPricing = (m) => {
		setPricing(m);
		setPriceIn(m.price_input ?? 0);
		setPriceOut(m.price_output ?? 0);
		setPriceCached(m.price_cached ?? 0);
	};
	const savePricing = () => {
		updateModel.mutate({
			id: pricing.id,
			price_input: Number(priceIn) || 0,
			price_output: Number(priceOut) || 0,
			price_cached: Number(priceCached) || 0,
		});
		setPricing(null);
	};
	const {
		data: catalog,
		isFetching: catalogLoading,
		isError: catalogError,
		error: catalogErr,
		refetch: loadCatalog,
		isFetched: catalogFetched,
	} = useAvailableModels(providerId);

	// Models already added so we can flag/grey them in the suggestion list.
	const existingIds = new Set(models.map((m) => m.model_id));
	const available = catalog?.models || [];
	const suggestions = available.filter((id) =>
		id.toLowerCase().includes(modelId.trim().toLowerCase()),
	);

	const openPicker = () => {
		setPicker(true);
		if (!catalogFetched && !catalogLoading) loadCatalog();
	};

	const pick = (id) => {
		setModelId(id);
		if (!displayName.trim()) setDisplayName(id);
		setPicker(false);
		// Ollama exposes per-model capabilities — auto-fill vision + context.
		if (providerKind === "ollama") {
			fetchModelMeta(providerId, id)
				.then((meta) => {
					if (meta?.supports_vision) setVision(true);
					if (meta?.context_window) setCtxWindow(meta.context_window);
				})
				.catch(() => {});
		}
	};

	const add = async () => {
		if (!modelId.trim() || !displayName.trim()) return;
		setError("");
		try {
			await createModel.mutateAsync({
				providerId,
				model_id: modelId.trim(),
				display_name: displayName.trim(),
				supports_thinking: thinking,
				supports_vision: vision,
				...(ctxWindow ? { context_window: ctxWindow } : {}),
			});
			setModelId("");
			setDisplayName("");
			setVision(false);
			setCtxWindow(null);
		} catch (e) {
			setError(errMsg(e, "Failed to add model"));
		}
	};

	return (
		<div className="ag-models">
			{models.map((m) => (
				<div key={m.id} className="ag-model">
					<button
						type="button"
						className="ag-star"
						title={m.is_default ? "Default model" : "Set as default"}
						onClick={() => updateModel.mutate({ id: m.id, is_default: true })}
						data-on={m.is_default ? "true" : undefined}
					>
						{m.is_default ? "★" : "☆"}
					</button>
					<div className="ag-model-id">
						<strong className="ag-model-name">{m.display_name}</strong>
						<span className="ag-muted ag-model-wire">{m.model_id}</span>
					</div>
					<div className="ag-model-caps">
						<button
							type="button"
							className={`ag-cap${m.supports_thinking ? " is-on ag-cap--purple" : ""}`}
							title={
								m.supports_thinking
									? "Thinking enabled — click to disable"
									: "Enable extended thinking"
							}
							onClick={() =>
								updateModel.mutate({
									id: m.id,
									supports_thinking: !m.supports_thinking,
								})
							}
						>
							thinking
						</button>
						<button
							type="button"
							className={`ag-cap${m.supports_vision ? " is-on ag-cap--green" : ""}`}
							title={
								m.supports_vision
									? "Vision enabled — click to disable"
									: "Enable vision (image input)"
							}
							onClick={() =>
								updateModel.mutate({
									id: m.id,
									supports_vision: !m.supports_vision,
								})
							}
						>
							vision
						</button>
					</div>
					<div className="ag-model-actions">
						<button
							type="button"
							className="ag-price"
							title="Set token prices (USD per 1M tokens, in / out)"
							onClick={() => openPricing(m)}
						>
							${m.price_input ?? 0}/${m.price_output ?? 0}
						</button>
						<button
							type="button"
							className="ag-btn--icon ag-btn--danger"
							title="Delete model"
							onClick={() => setPendingDelete(m)}
						>
							✕
						</button>
					</div>
				</div>
			))}
			<div className="ag-model-add">
				<div className="ag-model-add-fields">
					<div className="ag-combo">
						<input
							className="ag-input"
							placeholder="wire id (deepseek-chat)"
							value={modelId}
							onChange={(e) => setModelId(e.target.value)}
							onFocus={openPicker}
							onBlur={() => setTimeout(() => setPicker(false), 150)}
						/>
						{picker && (
							<div className="ag-combo-menu">
								{catalogLoading && (
									<div className="ag-combo-note">Loading models…</div>
								)}
								{catalogError && (
									<div className="ag-combo-note ag-error" style={{ margin: 0 }}>
										{errMsg(catalogErr, "Couldn't list models")}
									</div>
								)}
								{!catalogLoading &&
									!catalogError &&
									(suggestions.length ? (
										suggestions.map((id) => (
											<button
												type="button"
												key={id}
												className="ag-combo-item"
												// mouse-down fires before the input's blur, so the
												// pick lands before the menu closes.
												onMouseDown={(e) => {
													e.preventDefault();
													pick(id);
												}}
												disabled={existingIds.has(id)}
											>
												{id}
												{existingIds.has(id) && (
													<span className="ag-muted">added</span>
												)}
											</button>
										))
									) : (
										<div className="ag-combo-note">
											{available.length ? "No match" : "No models returned"}
										</div>
									))}
							</div>
						)}
					</div>
					<input
						className="ag-input"
						placeholder="display name"
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
					/>
				</div>
				<div className="ag-model-add-opts">
					<PvCheckbox
						checked={thinking}
						onChange={setThinking}
						label="thinking"
					/>
					<PvCheckbox
						checked={vision}
						onChange={setVision}
						label="vision"
					/>
					<button
						type="button"
						className="ag-btn ag-btn--sm ag-btn--primary"
						onClick={add}
					>
						+ Add model
					</button>
				</div>
			</div>
			{error && <div className="ag-error">{error}</div>}
			<PvModal
				open={!!pendingDelete}
				title="Delete model"
				danger
				confirmText="Delete"
				onConfirm={() => {
					deleteModel.mutate(pendingDelete.id);
					setPendingDelete(null);
				}}
				onCancel={() => setPendingDelete(null)}
			>
				Delete <strong>{pendingDelete?.display_name}</strong>? This can't be
				undone.
			</PvModal>
			<PvModal
				open={!!pricing}
				title={`Token prices — ${pricing?.display_name || ""}`}
				confirmText="Save"
				onConfirm={savePricing}
				onCancel={() => setPricing(null)}
			>
				<p className="ag-muted" style={{ marginTop: 0 }}>
					USD per 1M tokens. Used to estimate spend on the Token Usage page.
				</p>
				<label className="ag-row" style={{ gap: 8, marginBottom: 8 }}>
					<span style={{ minWidth: 110 }}>Input</span>
					<input
						className="ag-input"
						type="number"
						min="0"
						step="0.01"
						value={priceIn}
						onChange={(e) => setPriceIn(e.target.value)}
					/>
				</label>
				<label className="ag-row" style={{ gap: 8, marginBottom: 8 }}>
					<span style={{ minWidth: 110 }}>Output</span>
					<input
						className="ag-input"
						type="number"
						min="0"
						step="0.01"
						value={priceOut}
						onChange={(e) => setPriceOut(e.target.value)}
					/>
				</label>
				<label className="ag-row" style={{ gap: 8 }}>
					<span style={{ minWidth: 110 }}>Cached (read)</span>
					<input
						className="ag-input"
						type="number"
						min="0"
						step="0.01"
						value={priceCached}
						onChange={(e) => setPriceCached(e.target.value)}
					/>
				</label>
			</PvModal>
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
	const [pendingDelete, setPendingDelete] = useState(null);

	const isLocal = LOCAL_KINDS.has(kind);

	// Picking a local runtime pre-fills its default endpoint + name (only when
	// the fields are still empty, so we never clobber what the user typed).
	const onKindChange = (k) => {
		setKind(k);
		if (LOCAL_KINDS.has(k)) {
			if (!baseUrl.trim()) setBaseUrl(DEFAULT_BASE_URL[k]);
			if (!displayName.trim()) setDisplayName(KIND_LABEL[k]);
		}
	};

	const create = async () => {
		// Local runtimes don't need an API key; everyone else does.
		if (!displayName.trim() || (!isLocal && !apiKey.trim())) {
			setError(
				isLocal
					? "Display name is required"
					: "Display name and API key are required",
			);
			return;
		}
		setError("");
		try {
			await createProvider.mutateAsync({
				kind,
				display_name: displayName.trim(),
				// LM Studio / Ollama ignore the key but the column is non-null and the
				// adapter sends a bearer — use a placeholder when none was given.
				api_key: apiKey.trim() || (isLocal ? "local" : ""),
				base_url:
					baseUrl.trim() || (isLocal ? DEFAULT_BASE_URL[kind] : undefined),
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
								onChange={(e) => onKindChange(e.target.value)}
							>
								{PROVIDER_KINDS.map((k) => (
									<option key={k} value={k}>
										{KIND_LABEL[k] || k}
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
								placeholder={isLocal ? KIND_LABEL[kind] : "DeepSeek"}
							/>
						</div>
						<div className="ag-field">
							<span className="ag-label">
								API key{isLocal ? " (not needed)" : ""}
							</span>
							<input
								className="ag-input"
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder={isLocal ? "— leave blank —" : "sk-…"}
								disabled={isLocal}
							/>
						</div>
						<div className="ag-field">
							<span className="ag-label">
								Base URL{isLocal ? "" : " (optional)"}
							</span>
							<input
								className="ag-input"
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
								placeholder={
									isLocal ? DEFAULT_BASE_URL[kind] : "https://api.deepseek.com"
								}
							/>
							{isLocal && (
								<span className="ag-hint">
									Use <code>localhost</code> if the model server runs on the
									same machine as the backend — it's auto-mapped to the host
									from inside the container. Otherwise use the host's ZeroTier
									IP. Keep the <code>/v1</code> path.
								</span>
							)}
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
								onClick={() => setPendingDelete(p)}
							>
								✕
							</button>
						</div>
						<div className="ag-card-body">
							<ModelsList providerId={p.id} providerKind={p.kind} />
						</div>
					</div>
				))}
			</div>
			<PvModal
				open={!!pendingDelete}
				title="Delete provider"
				danger
				confirmText="Delete"
				onConfirm={() => {
					deleteProvider.mutate(pendingDelete.id);
					setPendingDelete(null);
				}}
				onCancel={() => setPendingDelete(null)}
			>
				Delete <strong>{pendingDelete?.display_name}</strong> and all its
				models? This can't be undone.
			</PvModal>
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
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">Agents</h1>
					<p className="vp-page-subtitle">
						Multi-provider LLM setup. Add a provider + model and tune the
						agent's config. Chat lives in the main app (and mobile).
					</p>
				</div>
			</div>
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
