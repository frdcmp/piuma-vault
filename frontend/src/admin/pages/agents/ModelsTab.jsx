import { useEffect, useState } from "react";
import {
	PvButton,
	PvEmpty,
	PvField,
	PvIconButton,
	PvInput,
	PvModal,
	PvPanel,
	PvSelect,
	PvSpin,
	PvSwitch,
	PvTable,
	PvTag,
	pvConfirm,
	pvMessage,
} from "@/ui";
import { fetchModelMeta } from "../../../api/agentChatApi";
import {
	useAllModels,
	useAvailableModels,
	useCreateModel,
	useCreateProvider,
	useDeleteModel,
	useDeleteProvider,
	useModels,
	useProviders,
	useUpdateModel,
	useUpdateProvider,
} from "../../../queries";

const KINDS = [
	{ value: "deepseek", label: "DeepSeek" },
	{ value: "anthropic", label: "Anthropic" },
	{ value: "openai", label: "OpenAI-compatible" },
	{ value: "gemini", label: "Gemini" },
	{ value: "minimax", label: "MiniMax" },
	{ value: "ollama", label: "Ollama (local)" },
	{ value: "lmstudio", label: "LM Studio (local)" },
];
const kindLabel = (k) => KINDS.find((x) => x.value === k)?.label ?? k;

// Local, OpenAI-compatible runtimes: no key, and the usual localhost URL (the backend maps
// localhost to the docker host when it calls out). The URL keeps its /v1.
const LOCAL = new Set(["ollama", "lmstudio"]);
const LOCAL_URL = {
	ollama: "http://localhost:11434/v1",
	lmstudio: "http://localhost:1234/v1",
};

export const errMsg = (e, fallback) =>
	e?.response?.data?.error || e?.message || fallback;

/** "$0.3", "$0.006"; "—" for nothing */
const usd = (n) => (n > 0 ? `$${Number(n.toFixed(4))}` : "—");
/** 128000 → "128K", 1048576 → "1M" */
const ctx = (n) =>
	!n
		? "—"
		: n >= 1_000_000
			? `${Number((n / 1_048_576).toFixed(1))}M`
			: `${Math.round(n / 1000)}K`;

/**
 * The models the Vault Agent can run: the providers on the left, the chosen one's models on the
 * right (the starred one is what a new chat starts on). A provider and a model are added and
 * edited in a dialog.
 */
export default function ModelsTab() {
	const { data: providers = [], isLoading } = useProviders();
	const { data: all = [] } = useAllModels();
	const [selected, setSelected] = useState(null);
	const [editingProvider, setEditingProvider] = useState(null);

	// keep a provider chosen: the first one, or the next one after a delete
	useEffect(() => {
		if (!providers.length) setSelected(null);
		else if (!providers.some((p) => p.id === selected))
			setSelected(providers[0].id);
	}, [providers, selected]);

	const current = providers.find((p) => p.id === selected);
	const def = all.find((m) => m.is_default);
	const count = (p) => all.filter((m) => m.provider === p.display_name).length;

	if (isLoading) return <PvSpin block label="Loading providers…" />;
	return (
		<div className="ag-models">
			<div className="ag-default">
				<span className="ag-default__star">★</span>
				{def ? (
					<span>
						New chats start on <strong>{def.display_name}</strong>
						<span className="vp-muted"> · {def.provider}</span>
					</span>
				) : (
					<span className="vp-muted">
						No default model: star one below, or chats can't start.
					</span>
				)}
			</div>

			<div className="ag-split">
				<PvPanel
					title="Providers"
					noPad
					extra={
						<PvButton
							size="sm"
							variant="primary"
							onClick={() => setEditingProvider("new")}
						>
							+ Add
						</PvButton>
					}
				>
					{providers.length ? (
						<ul className="ag-plist">
							{providers.map((p) => (
								<li key={p.id}>
									<button
										type="button"
										className="ag-plist__item"
										aria-current={p.id === selected ? "true" : undefined}
										onClick={() => setSelected(p.id)}
									>
										<span className="ag-plist__name">{p.display_name}</span>
										<span className="ag-plist__meta">
											{kindLabel(p.kind)} · {count(p)} model
											{count(p) === 1 ? "" : "s"}
										</span>
										{!p.has_key && !LOCAL.has(p.kind) && (
											<span className="ag-plist__warn" title="No API key">
												no key
											</span>
										)}
										{!p.enabled && <span className="ag-plist__off">off</span>}
									</button>
								</li>
							))}
						</ul>
					) : (
						<PvEmpty compact description="No providers yet">
							<PvButton
								size="sm"
								variant="primary"
								onClick={() => setEditingProvider("new")}
							>
								Add one
							</PvButton>
						</PvEmpty>
					)}
				</PvPanel>

				{current ? (
					<ProviderDetail
						provider={current}
						onEdit={() => setEditingProvider(current)}
					/>
				) : (
					<PvPanel title="Models">
						<PvEmpty description="Add a provider to give the agent its models" />
					</PvPanel>
				)}
			</div>

			<ProviderModal
				target={editingProvider}
				onClose={() => setEditingProvider(null)}
				onCreated={(p) => p?.id && setSelected(p.id)}
			/>
		</div>
	);
}

function ProviderDetail({ provider: p, onEdit }) {
	const { data: models = [], isLoading } = useModels(p.id);
	const update = useUpdateModel();
	const del = useDeleteModel();
	const delProvider = useDeleteProvider();
	const [editing, setEditing] = useState(null);

	const toggle = (m, field) =>
		update.mutate(
			{ id: m.id, [field]: !m[field] },
			{ onError: (e) => pvMessage.error(errMsg(e, "Couldn't save")) },
		);
	const removeProvider = async () => {
		const ok = await pvConfirm({
			title: `Delete ${p.display_name}?`,
			content: `Its ${models.length} model${models.length === 1 ? "" : "s"} go with it. This can't be undone.`,
			okText: "Delete",
			danger: true,
		});
		if (ok)
			delProvider.mutate(p.id, {
				onSuccess: () => pvMessage.success("Provider deleted"),
				onError: (e) => pvMessage.error(errMsg(e, "Couldn't delete")),
			});
	};
	const removeModel = async (m) => {
		const ok = await pvConfirm({
			title: `Delete ${m.display_name}?`,
			content: "Chats on it move to the default model. This can't be undone.",
			okText: "Delete",
			danger: true,
		});
		if (ok)
			del.mutate(m.id, {
				onSuccess: () => pvMessage.success("Model deleted"),
				onError: (e) => pvMessage.error(errMsg(e, "Couldn't delete")),
			});
	};

	const columns = [
		{
			key: "default",
			title: "",
			width: 36,
			render: (_, m) => (
				<PvIconButton
					size="sm"
					variant="ghost"
					active={m.is_default}
					label={m.is_default ? "The default model" : "Make it the default"}
					icon={m.is_default ? "★" : "☆"}
					onClick={(e) => {
						e.stopPropagation();
						if (!m.is_default)
							update.mutate(
								{ id: m.id, is_default: true },
								{
									onSuccess: () =>
										pvMessage.success(`New chats start on ${m.display_name}`),
								},
							);
					}}
				/>
			),
		},
		{
			key: "name",
			title: "Model",
			sorter: (a, b) => a.display_name.localeCompare(b.display_name),
			render: (_, m) => (
				<div className="ag-mname">
					<strong>{m.display_name}</strong>
					<code>{m.model_id}</code>
				</div>
			),
		},
		{
			key: "caps",
			title: "Can",
			render: (_, m) => (
				<div className="ag-caps">
					<Cap
						on={m.supports_thinking}
						label="thinking"
						tone="var(--vp-violet)"
						onClick={() => toggle(m, "supports_thinking")}
					/>
					<Cap
						on={m.supports_vision}
						label="vision"
						tone="var(--vp-info)"
						onClick={() => toggle(m, "supports_vision")}
					/>
					<Cap
						on={m.supports_tools}
						label="tools"
						tone="var(--vp-success)"
						onClick={() => toggle(m, "supports_tools")}
					/>
				</div>
			),
		},
		{
			key: "ctx",
			title: "Context",
			align: "right",
			render: (_, m) => (
				<span className="vp-muted">{ctx(m.context_window)}</span>
			),
		},
		{
			key: "price",
			title: "Price / 1M · in · cached · out",
			align: "right",
			render: (_, m) =>
				m.price_input || m.price_output || m.price_cached ? (
					<span className="ag-price">
						{usd(m.price_input)} <span className="vp-muted">·</span>{" "}
						<span className="vp-muted">{usd(m.price_cached)}</span>{" "}
						<span className="vp-muted">·</span> {usd(m.price_output)}
					</span>
				) : (
					<span className="vp-muted">no price</span>
				),
		},
		{
			key: "actions",
			title: "",
			width: 72,
			align: "right",
			render: (_, m) => (
				<div className="ag-row-actions">
					<PvIconButton
						size="sm"
						variant="ghost"
						label="Edit"
						icon="✎"
						onClick={(e) => {
							e.stopPropagation();
							setEditing(m);
						}}
					/>
					<PvIconButton
						size="sm"
						variant="ghost-danger"
						label="Delete"
						icon="✕"
						onClick={(e) => {
							e.stopPropagation();
							removeModel(m);
						}}
					/>
				</div>
			),
		},
	];

	return (
		<PvPanel
			title={p.display_name}
			extra={
				<div className="ag-row-actions">
					<PvButton size="sm" onClick={onEdit}>
						Edit
					</PvButton>
					<PvIconButton
						size="sm"
						variant="ghost-danger"
						label="Delete provider"
						icon="✕"
						onClick={removeProvider}
					/>
				</div>
			}
		>
			<dl className="ag-facts">
				<div>
					<dt>Kind</dt>
					<dd>{kindLabel(p.kind)}</dd>
				</div>
				<div>
					<dt>API key</dt>
					<dd>
						{LOCAL.has(p.kind) ? (
							<span className="vp-muted">not needed</span>
						) : p.has_key ? (
							<code>{p.api_key_masked}</code>
						) : (
							<PvTag color="var(--vp-danger)">missing</PvTag>
						)}
					</dd>
				</div>
				<div>
					<dt>Endpoint</dt>
					<dd>
						{p.base_url ? (
							<code>{p.base_url}</code>
						) : (
							<span className="vp-muted">the provider's own</span>
						)}
					</dd>
				</div>
				<div>
					<dt>Status</dt>
					<dd>
						{p.enabled ? (
							<PvTag color="var(--vp-success)">on</PvTag>
						) : (
							<PvTag>off</PvTag>
						)}
					</dd>
				</div>
			</dl>

			<div className="ag-toolbar">
				<span className="ag-toolbar__title">
					Models <span className="vp-muted">{models.length}</span>
				</span>
				<PvButton size="sm" variant="primary" onClick={() => setEditing("new")}>
					+ Add model
				</PvButton>
			</div>
			<PvTable
				size="sm"
				minWidth={640}
				columns={columns}
				data={models}
				rowKey="id"
				loading={isLoading}
				onRowClick={(m) => setEditing(m)}
				emptyText="No models yet: add the first one."
			/>

			<ModelModal
				provider={p}
				target={editing}
				onClose={() => setEditing(null)}
			/>
		</PvPanel>
	);
}

/** A capability: lit when the model has it; a click switches it. */
function Cap({ on, label, tone, onClick }) {
	return (
		<button
			type="button"
			className="ag-cap"
			data-on={on ? "true" : undefined}
			style={on ? { "--ag-cap": tone } : undefined}
			title={
				on
					? `${label}: on (click to turn off)`
					: `${label}: off (click to turn on)`
			}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
		>
			{label}
		</button>
	);
}

// ── dialogs ──────────────────────────────────────────────────────────────────

const blankModel = {
	model_id: "",
	display_name: "",
	supports_thinking: true,
	supports_vision: false,
	supports_tools: true,
	context_window: "",
	price_input: "",
	price_cached: "",
	price_output: "",
};
const num = (s) => {
	const t = String(s ?? "").trim();
	if (!t) return 0;
	const n = Number(t.replace(",", "."));
	return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
};

/** Add a model to a provider (its id picked from the provider's list), or edit one. */
function ModelModal({ provider: p, target, onClose }) {
	const create = useCreateModel();
	const update = useUpdateModel();
	const isNew = target === "new";
	const [v, setV] = useState(blankModel);
	const [picker, setPicker] = useState(false);
	const catalog = useAvailableModels(p.id);

	useEffect(() => {
		if (!target) return;
		setV(
			isNew
				? blankModel
				: {
						model_id: target.model_id,
						display_name: target.display_name,
						supports_thinking: target.supports_thinking,
						supports_vision: target.supports_vision,
						supports_tools: target.supports_tools,
						context_window: target.context_window ?? "",
						price_input: target.price_input || "",
						price_cached: target.price_cached || "",
						price_output: target.price_output || "",
					},
		);
	}, [target, isNew]);

	const set = (patch) => setV((x) => ({ ...x, ...patch }));
	const listed = catalog.data?.models ?? [];
	const typed = v.model_id.trim().toLowerCase();
	const hits = listed
		.filter((id) => id.toLowerCase().includes(typed))
		.slice(0, 60);
	const openPicker = () => {
		setPicker(true);
		if (!catalog.isFetched && !catalog.isFetching) catalog.refetch();
	};
	const pick = (id) => {
		set({
			model_id: id,
			display_name: v.display_name.trim() ? v.display_name : id,
		});
		setPicker(false);
		// Ollama says what a model can do: fill vision and the context window
		if (p.kind === "ollama")
			fetchModelMeta(p.id, id)
				.then((meta) => {
					if (meta?.supports_vision) set({ supports_vision: true });
					if (meta?.context_window)
						set({ context_window: meta.context_window });
				})
				.catch(() => {});
	};

	const save = async () => {
		const prices = [v.price_input, v.price_cached, v.price_output].map(num);
		const ctxw = num(v.context_window);
		if (!v.model_id.trim() || !v.display_name.trim())
			return pvMessage.error("The model's id and its name are needed");
		if (prices.some(Number.isNaN) || Number.isNaN(ctxw))
			return pvMessage.error(
				"Prices and the context window are numbers, 0 or more",
			);
		const body = {
			display_name: v.display_name.trim(),
			supports_thinking: v.supports_thinking,
			supports_vision: v.supports_vision,
			supports_tools: v.supports_tools,
			context_window: ctxw ? Math.round(ctxw) : null,
			price_input: prices[0],
			price_cached: prices[1],
			price_output: prices[2],
		};
		try {
			if (isNew)
				await create.mutateAsync({
					providerId: p.id,
					model_id: v.model_id.trim(),
					...body,
				});
			else await update.mutateAsync({ id: target.id, ...body });
			pvMessage.success(isNew ? "Model added" : "Model saved");
			onClose();
		} catch (e) {
			pvMessage.error(errMsg(e, "Couldn't save the model"));
		}
	};

	return (
		<PvModal
			open={!!target}
			width={560}
			title={
				isNew
					? `Add a model to ${p.display_name}`
					: `Edit ${target?.display_name ?? ""}`
			}
			confirmText={isNew ? "Add model" : "Save"}
			onConfirm={save}
			onCancel={onClose}
		>
			<div className="ag-form">
				<PvField
					label="Model id"
					required
					hint={
						isNew
							? "The provider's own id. Pick it from the list, or type one it doesn't list."
							: "Can't change: add a new model instead."
					}
				>
					<div className="ag-combo">
						<PvInput
							value={v.model_id}
							disabled={!isNew}
							placeholder="deepseek-chat"
							onChange={(e) => set({ model_id: e.target.value })}
							onFocus={isNew ? openPicker : undefined}
							onBlur={() => setTimeout(() => setPicker(false), 150)}
						/>
						{isNew && picker && (
							<div className="ag-combo__menu">
								{catalog.isFetching ||
								(!catalog.isFetched && !catalog.isError) ? (
									<div className="ag-combo__note">
										<PvSpin label="Asking the provider…" />
									</div>
								) : catalog.isError ? (
									<div className="ag-combo__note ag-combo__note--error">
										{errMsg(
											catalog.error,
											"The provider didn't list its models",
										)}
									</div>
								) : hits.length ? (
									hits.map((id) => (
										<button
											type="button"
											key={id}
											className="ag-combo__item"
											// mouse-down lands before the input's blur closes the menu
											onMouseDown={(e) => {
												e.preventDefault();
												pick(id);
											}}
										>
											{id}
										</button>
									))
								) : (
									<div className="ag-combo__note">
										{listed.length
											? "None match: keep what you typed"
											: "The provider lists none"}
									</div>
								)}
							</div>
						)}
					</div>
				</PvField>
				<PvField
					label="Name"
					required
					hint="What the chat's model picker shows"
				>
					<PvInput
						value={v.display_name}
						placeholder="DeepSeek Chat"
						onChange={(e) => set({ display_name: e.target.value })}
					/>
				</PvField>
				<PvField as="div" label="It can">
					<div className="ag-switches">
						<PvSwitch
							checked={v.supports_thinking}
							onChange={(c) => set({ supports_thinking: c })}
							label="Think (reasoning)"
						/>
						<PvSwitch
							checked={v.supports_vision}
							onChange={(c) => set({ supports_vision: c })}
							label="See images"
						/>
						<PvSwitch
							checked={v.supports_tools}
							onChange={(c) => set({ supports_tools: c })}
							label="Use tools"
						/>
					</div>
				</PvField>
				<PvField
					label="Context window"
					hint="In tokens; empty: the provider's default"
				>
					<PvInput
						type="number"
						min="0"
						value={v.context_window}
						placeholder="128000"
						onChange={(e) => set({ context_window: e.target.value })}
					/>
				</PvField>
				<PvField
					as="div"
					label="Price per 1M tokens, in dollars"
					hint="Input, cached input, output: what the Token Usage page counts. Empty: free."
				>
					<div className="ag-prices">
						<PvInput
							type="number"
							min="0"
							step="0.001"
							prefix="in"
							value={v.price_input}
							onChange={(e) => set({ price_input: e.target.value })}
							aria-label="Input price"
						/>
						<PvInput
							type="number"
							min="0"
							step="0.001"
							prefix="cached"
							value={v.price_cached}
							onChange={(e) => set({ price_cached: e.target.value })}
							aria-label="Cached input price"
						/>
						<PvInput
							type="number"
							min="0"
							step="0.001"
							prefix="out"
							value={v.price_output}
							onChange={(e) => set({ price_output: e.target.value })}
							aria-label="Output price"
						/>
					</div>
				</PvField>
			</div>
		</PvModal>
	);
}

/** Add a provider, or edit one (its key is only replaced when a new one is typed). */
function ProviderModal({ target, onClose, onCreated }) {
	const create = useCreateProvider();
	const update = useUpdateProvider();
	const isNew = target === "new";
	const [v, setV] = useState({});

	useEffect(() => {
		if (!target) return;
		setV(
			isNew
				? {
						kind: "deepseek",
						display_name: "",
						api_key: "",
						base_url: "",
						enabled: true,
					}
				: {
						kind: target.kind,
						display_name: target.display_name,
						api_key: "",
						base_url: target.base_url ?? "",
						enabled: target.enabled,
					},
		);
	}, [target, isNew]);

	const local = LOCAL.has(v.kind);
	const set = (patch) => setV((x) => ({ ...x, ...patch }));
	const onKind = (k) =>
		set({
			kind: k,
			...(LOCAL.has(k) && !v.base_url?.trim()
				? { base_url: LOCAL_URL[k] }
				: {}),
			...(!v.display_name?.trim() ? { display_name: kindLabel(k) } : {}),
		});

	const save = async () => {
		if (!v.display_name?.trim())
			return pvMessage.error("The provider needs a name");
		if (isNew && !local && !v.api_key?.trim())
			return pvMessage.error("The provider's API key is needed");
		try {
			if (isNew) {
				const made = await create.mutateAsync({
					kind: v.kind,
					display_name: v.display_name.trim(),
					// a local runtime ignores the key, but the column wants one
					api_key: v.api_key.trim() || (local ? "local" : ""),
					base_url:
						v.base_url.trim() || (local ? LOCAL_URL[v.kind] : undefined),
				});
				onCreated?.(made);
			} else
				await update.mutateAsync({
					id: target.id,
					display_name: v.display_name.trim(),
					api_key: v.api_key.trim(),
					// only a typed one: the backend keeps the stored URL for none
					base_url: v.base_url.trim() || undefined,
					enabled: v.enabled,
				});
			pvMessage.success(isNew ? "Provider added" : "Provider saved");
			onClose();
		} catch (e) {
			pvMessage.error(errMsg(e, "Couldn't save the provider"));
		}
	};

	return (
		<PvModal
			open={!!target}
			width={520}
			title={isNew ? "Add a provider" : `Edit ${target?.display_name ?? ""}`}
			confirmText={isNew ? "Add provider" : "Save"}
			onConfirm={save}
			onCancel={onClose}
		>
			<div className="ag-form">
				<PvField
					label="Kind"
					hint={isNew ? undefined : "Can't change: add a new provider instead."}
				>
					<PvSelect
						value={v.kind}
						onChange={onKind}
						options={KINDS}
						disabled={!isNew}
					/>
				</PvField>
				<PvField label="Name" required>
					<PvInput
						value={v.display_name ?? ""}
						placeholder={kindLabel(v.kind)}
						onChange={(e) => set({ display_name: e.target.value })}
					/>
				</PvField>
				{!local && (
					<PvField
						label="API key"
						required={isNew}
						hint={
							isNew
								? undefined
								: `Now ${target?.api_key_masked || "none"}. Empty keeps it; a new one replaces it.`
						}
					>
						<PvInput
							type="password"
							reveal
							value={v.api_key ?? ""}
							placeholder={isNew ? "sk-…" : "keep the current key"}
							onChange={(e) => set({ api_key: e.target.value })}
						/>
					</PvField>
				)}
				<PvField
					label="Endpoint"
					hint={
						local
							? "localhost works when the model server runs on this machine (it is mapped from inside the container); keep the /v1."
							: "Empty: the provider's own. An OpenAI-compatible one ends in /v1."
					}
				>
					<PvInput
						value={v.base_url ?? ""}
						placeholder={local ? LOCAL_URL[v.kind] : "https://api.deepseek.com"}
						onChange={(e) => set({ base_url: e.target.value })}
					/>
				</PvField>
				{!isNew && (
					<PvSwitch
						checked={!!v.enabled}
						onChange={(c) => set({ enabled: c })}
						label="On: its models can be picked in chat"
					/>
				)}
			</div>
		</PvModal>
	);
}
