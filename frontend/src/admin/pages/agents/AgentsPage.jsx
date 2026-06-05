import { useEffect, useRef, useState } from "react";
import { streamChat } from "../../../api/agentChatApi";
import {
	useAgentList,
	useAgentPersonas,
	useAgentProfile,
	useConversation,
	useConversations,
	useCreateConversation,
	useCreateModel,
	useCreateProvider,
	useDeleteConversation,
	useDeleteModel,
	useDeleteProvider,
	useModels,
	useProviders,
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

	useEffect(() => {
		if (profile)
			setPf({
				display_name: profile.display_name || "",
				instructions: profile.instructions || "",
				user_context: profile.user_context || "",
				memory: profile.memory || "",
			});
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
			await updateProfile.mutateAsync({ agent, ...pf });
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

// ── Chat ─────────────────────────────────────────────────────────────────────

function renderBlocks(content) {
	const blocks = Array.isArray(content) ? content : [];
	const thinking = blocks
		.filter((b) => b.type === "thinking")
		.map((b) => b.text)
		.join("");
	const text = blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	return { thinking, text };
}

function Bubble({ sender, text, thinking }) {
	const isUser = sender === "user";
	return (
		<div
			className={`ag-bubble ${isUser ? "ag-bubble--user" : "ag-bubble--assistant"}`}
		>
			{thinking ? (
				<details className="ag-thinking">
					<summary>💭 thinking</summary>
					<div className="ag-thinking-body">{thinking}</div>
				</details>
			) : null}
			<div>{text}</div>
		</div>
	);
}

function ChatTab({ agent }) {
	const { data: conversations = [] } = useConversations(agent);
	const createConversation = useCreateConversation();
	const deleteConversation = useDeleteConversation();
	const [activeId, setActiveId] = useState(null);
	const { data: convData, refetch } = useConversation(activeId);
	const [input, setInput] = useState("");
	const [streaming, setStreaming] = useState(false);
	const [liveText, setLiveText] = useState("");
	const [liveThinking, setLiveThinking] = useState("");
	const [optimisticUser, setOptimisticUser] = useState(null);
	const [error, setError] = useState("");
	const scrollRef = useRef(null);

	const messages = convData?.messages || [];

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll when new content arrives
	useEffect(() => {
		scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
	}, [messages, liveText, liveThinking]);

	const newConversation = async () => {
		try {
			const conv = await createConversation.mutateAsync({ agent });
			setActiveId(conv.id);
		} catch (e) {
			setError(errMsg(e, "Failed to start conversation"));
		}
	};

	const send = async () => {
		const text = input.trim();
		if (!text || streaming) return;
		setError("");
		let convId = activeId;
		if (!convId) {
			try {
				const conv = await createConversation.mutateAsync({ agent });
				convId = conv.id;
				setActiveId(conv.id);
			} catch (e) {
				setError(errMsg(e, "Failed to start conversation"));
				return;
			}
		}
		setInput("");
		setOptimisticUser(text);
		setLiveText("");
		setLiveThinking("");
		setStreaming(true);
		await streamChat({
			conversationId: convId,
			message: text,
			onText: (d) => setLiveText((t) => t + d),
			onThinking: (d) => setLiveThinking((t) => t + d),
			onError: (e) => setError(e.message || "Chat error"),
			onDone: () => {},
		});
		setStreaming(false);
		setOptimisticUser(null);
		setLiveText("");
		setLiveThinking("");
		await refetch();
	};

	return (
		<div className="ag-chat">
			<div className="ag-conv-list">
				<button
					type="button"
					className="ag-btn ag-btn--block"
					onClick={newConversation}
					style={{ marginBottom: 8 }}
				>
					+ New chat
				</button>
				{conversations.length === 0 && (
					<div
						className="ag-muted"
						style={{ textAlign: "center", padding: 12 }}
					>
						No conversations
					</div>
				)}
				{conversations.map((c) => (
					<div
						key={c.id}
						className={`ag-conv-item ${c.id === activeId ? "ag-conv-item--active" : ""}`}
					>
						<button
							type="button"
							className="ag-conv-title-btn ag-conv-title"
							onClick={() => setActiveId(c.id)}
						>
							{c.title || "Untitled"}
						</button>
						<button
							type="button"
							className="ag-btn--icon ag-btn--danger"
							title="Delete"
							onClick={() => {
								if (window.confirm("Delete conversation?")) {
									deleteConversation.mutate(c.id);
									if (c.id === activeId) setActiveId(null);
								}
							}}
						>
							✕
						</button>
					</div>
				))}
			</div>

			<div className="ag-chat-main">
				<div className="ag-msgs" ref={scrollRef}>
					{messages.length === 0 && !optimisticUser && !streaming && (
						<div className="ag-empty">Say hi to Piuma 🐾</div>
					)}
					{messages.map((m) => {
						const { thinking, text } = renderBlocks(m.content);
						return (
							<Bubble
								key={m.id}
								sender={m.role}
								text={text}
								thinking={thinking}
							/>
						);
					})}
					{optimisticUser && <Bubble sender="user" text={optimisticUser} />}
					{streaming && (
						<Bubble
							sender="assistant"
							text={liveText || "…"}
							thinking={liveThinking}
						/>
					)}
				</div>
				{error && (
					<div className="ag-error" style={{ padding: "0 10px" }}>
						{error}
					</div>
				)}
				<div className="ag-composer">
					<textarea
						className="ag-textarea"
						rows={1}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder="Message Piuma…"
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
					/>
					<button
						type="button"
						className="ag-btn ag-btn--primary"
						onClick={send}
						disabled={streaming}
					>
						{streaming ? "…" : "Send"}
					</button>
				</div>
			</div>
		</div>
	);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
	const { data: agents = [] } = useAgentList();
	const agent = agents[0]?.kind || "vault_agent";
	const [tab, setTab] = useState("chat");

	return (
		<div className="ag-page">
			<h1 className="ag-title">Agents</h1>
			<p className="ag-sub">
				Multi-provider LLM chat. Add a provider + model, tune the agent's
				config, and chat.
			</p>
			<div className="ag-tabs">
				{[
					["chat", "Chat"],
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
			{tab === "chat" && <ChatTab agent={agent} />}
			{tab === "providers" && <ProvidersTab />}
			{tab === "config" && <ConfigTab agent={agent} />}
		</div>
	);
}
