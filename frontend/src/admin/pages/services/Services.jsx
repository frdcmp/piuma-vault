import { useEffect, useState } from "react";
import {
	useServices,
	useTestEmbedding,
	useTestStorage,
	useTestWebsearch,
	useUpdateServices,
} from "../../../queries";
import { PageContent } from "../../components/layout/PageLayout";
import {
	PvButton,
	PvModal,
	PvPanel,
	pvMessage,
} from "../../components/ui";
import "../../vault-pixel.css";
import "./services.css";

const EMPTY = {
	azure_embedding_url: "",
	azure_embedding_api_key: "",
	s3_endpoint: "",
	s3_region: "",
	s3_bucket: "",
	s3_access_key_id: "",
	s3_secret_access_key: "",
	s3_cdn_url: "",
	s3_cdn_token_key: "",
	websearch_provider: "brave",
	websearch_brave_api_key: "",
	websearch_tavily_api_key: "",
	websearch_serpapi_api_key: "",
	websearch_exa_api_key: "",
};

// Service tabs. Each maps to one panel below; the form state is shared, so a
// single "Save changes" persists edits across every tab.
const TABS = [
	{ id: "embeddings", label: "Embeddings" },
	{ id: "search", label: "Search" },
	{ id: "storage", label: "Storage" },
];

// Web-search providers we ship adapters for. Each has its own key setting.
const WEBSEARCH_PROVIDERS = [
	{
		id: "brave",
		label: "Brave",
		key: "websearch_brave_api_key",
		hint: "api.search.brave.com — independent index, generous free tier",
	},
	{
		id: "tavily",
		label: "Tavily",
		key: "websearch_tavily_api_key",
		hint: "api.tavily.com — built for LLMs",
	},
	{
		id: "serpapi",
		label: "SerpAPI (Google)",
		key: "websearch_serpapi_api_key",
		hint: "serpapi.com — Google results",
	},
	{
		id: "exa",
		label: "Exa",
		key: "websearch_exa_api_key",
		hint: "api.exa.ai — neural/semantic search",
	},
];

// The storage backend is plain S3 under the hood; only the field labels and
// placeholders change with the vendor preset. Click the panel title to toggle.
const VENDORS = {
	aws: {
		label: "s3 / aws",
		desc: "S3-compatible object storage for files and attachments. Works with AWS S3, Bunny, Cloudflare R2, MinIO, and the like.",
		endpoint: { label: "Endpoint", ph: "https://s3.us-east-1.amazonaws.com" },
		region: { label: "Region", ph: "us-east-1" },
		bucket: { label: "Bucket", ph: "my-bucket" },
		accessKey: { label: "Access Key ID", ph: "AKIA…" },
		secret: { label: "Secret Access Key" },
		cdnUrl: { label: "CDN URL", ph: "https://cdn.example.com (optional)" },
		cdnToken: { label: "CDN Token Key" },
	},
	bunny: {
		label: "s3 / bunny",
		desc: "Bunny Storage (S3-compatible). The storage zone name is both the bucket and the access key; the zone password is the secret. CDN delivery uses your pull zone + URL token-auth key.",
		endpoint: {
			label: "Storage Endpoint",
			ph: "https://sg-s3.storage.bunnycdn.com",
		},
		region: { label: "Storage Region", ph: "sg" },
		bucket: { label: "Storage Zone Name", ph: "my-zone (bucket + access key)" },
		accessKey: { label: "Storage Zone Name", ph: "my-zone (same as the zone)" },
		secret: { label: "Storage Password" },
		cdnUrl: { label: "Pull Zone URL", ph: "https://my-zone.b-cdn.net" },
		cdnToken: { label: "URL Token Auth Key" },
	},
};

// Bunny's S3 conventions, imported into any blank fields when the preset is
// switched to Bunny.
const BUNNY_DEFAULTS = {
	s3_endpoint: "https://sg-s3.storage.bunnycdn.com",
	s3_region: "sg",
};

const Services = () => {
	const { data, isLoading, error } = useServices();
	const update = useUpdateServices();
	const testEmb = useTestEmbedding();
	const testS3 = useTestStorage();
	const testWs = useTestWebsearch();
	const [form, setForm] = useState(EMPTY);
	const [embResult, setEmbResult] = useState(null);
	const [s3Result, setS3Result] = useState(null);
	const [wsResult, setWsResult] = useState(null);
	const [vendor, setVendor] = useState("aws");
	const [activeTab, setActiveTab] = useState("embeddings");
	const v = VENDORS[vendor];

	// Pick the storage adapter preset (AWS ⇄ Bunny). Switching to Bunny imports
	// its S3 conventions into blank fields (Bunny uses the zone name as both
	// bucket and access key, so mirror them).
	const selectVendor = (e) => {
		const next = e.target.value;
		setVendor(next);
		if (next === "bunny") {
			setForm((f) => ({
				...f,
				s3_endpoint: f.s3_endpoint || BUNNY_DEFAULTS.s3_endpoint,
				s3_region: f.s3_region || BUNNY_DEFAULTS.s3_region,
				s3_access_key_id: f.s3_access_key_id || f.s3_bucket,
			}));
		}
	};

	// Seed the non-secret fields from the server; secrets stay blank (write-only).
	useEffect(() => {
		if (data) {
			setForm((f) => ({
				...f,
				azure_embedding_url: data.azure_embedding_url || "",
				s3_endpoint: data.s3_endpoint || "",
				s3_region: data.s3_region || "",
				s3_bucket: data.s3_bucket || "",
				s3_access_key_id: data.s3_access_key_id || "",
				s3_cdn_url: data.s3_cdn_url || "",
				websearch_provider: data.websearch_provider || "brave",
			}));
		}
	}, [data]);

	const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

	// Bunny uses the storage zone name as both the bucket and the access key, so
	// in Bunny mode a single field drives both.
	const setZone = (e) =>
		setForm((f) => ({
			...f,
			s3_bucket: e.target.value,
			s3_access_key_id: e.target.value,
		}));

	const handleSave = async () => {
		// URLs are always sent; secrets only when the admin typed a new value
		// (blank = keep existing, since the field is never prefilled).
		const payload = {
			azure_embedding_url: form.azure_embedding_url.trim(),
			s3_endpoint: form.s3_endpoint.trim(),
			s3_region: form.s3_region.trim(),
			s3_bucket: form.s3_bucket.trim(),
			s3_access_key_id: form.s3_access_key_id.trim(),
			s3_cdn_url: form.s3_cdn_url.trim(),
			websearch_provider: form.websearch_provider || "brave",
		};
		if (form.azure_embedding_api_key.trim())
			payload.azure_embedding_api_key = form.azure_embedding_api_key.trim();
		if (form.s3_secret_access_key.trim())
			payload.s3_secret_access_key = form.s3_secret_access_key.trim();
		if (form.s3_cdn_token_key.trim())
			payload.s3_cdn_token_key = form.s3_cdn_token_key.trim();
		// Any web-search key the admin typed (for any provider).
		for (const p of WEBSEARCH_PROVIDERS) {
			if (form[p.key].trim()) payload[p.key] = form[p.key].trim();
		}

		try {
			await update.mutateAsync(payload);
			setForm((f) => ({
				...f,
				azure_embedding_api_key: "",
				s3_secret_access_key: "",
				s3_cdn_token_key: "",
				websearch_brave_api_key: "",
				websearch_tavily_api_key: "",
				websearch_serpapi_api_key: "",
				websearch_exa_api_key: "",
			}));
			pvMessage.success("Services saved");
		} catch (err) {
			pvMessage.error(
				err?.response?.data?.error || "Failed to save services",
			);
		}
	};

	// Runs a "try now" check against the current (possibly unsaved) form values
	// passed as `payload`; blank secrets fall back to the saved config server-side.
	const runTest = async (mutation, setResult, payload) => {
		setResult(null);
		try {
			const r = await mutation.mutateAsync(payload);
			setResult(r);
		} catch (err) {
			setResult({
				ok: false,
				message: err?.response?.data?.error || "Test failed",
			});
		}
	};

	// A pending clear awaiting confirmation: { keys, setResult, label }.
	const [confirmClear, setConfirmClear] = useState(null);
	const requestClear = (keys, setResult, label) =>
		setConfirmClear({ keys, setResult, label });
	const confirmClearNow = async () => {
		if (!confirmClear) return;
		const { keys, setResult } = confirmClear;
		setConfirmClear(null);
		await clearService(keys, setResult);
	};

	// Clears a service's stored credentials: sends the card's fields as empty
	// (the backend treats empty = clear) and blanks the form inputs.
	const clearService = async (keys, setResult) => {
		const payload = {};
		for (const k of keys) payload[k] = "";
		try {
			await update.mutateAsync(payload);
			setForm((f) => {
				const next = { ...f };
				for (const k of keys) next[k] = "";
				return next;
			});
			setResult?.(null);
			pvMessage.success("Credentials cleared");
		} catch (err) {
			pvMessage.error(
				err?.response?.data?.error || "Failed to clear credentials",
			);
		}
	};

	const EMB_KEYS = ["azure_embedding_url", "azure_embedding_api_key"];
	const S3_KEYS = [
		"s3_endpoint",
		"s3_region",
		"s3_bucket",
		"s3_access_key_id",
		"s3_secret_access_key",
		"s3_cdn_url",
		"s3_cdn_token_key",
	];

	// Current form values for a live test; blank secrets fall back to saved.
	const embTestPayload = () => {
		const p = { azure_embedding_url: form.azure_embedding_url.trim() };
		if (form.azure_embedding_api_key.trim())
			p.azure_embedding_api_key = form.azure_embedding_api_key.trim();
		return p;
	};

	const s3TestPayload = () => {
		const p = {
			s3_endpoint: form.s3_endpoint.trim(),
			s3_region: form.s3_region.trim(),
			s3_bucket: form.s3_bucket.trim(),
			s3_access_key_id: form.s3_access_key_id.trim(),
			s3_cdn_url: form.s3_cdn_url.trim(),
		};
		if (form.s3_secret_access_key.trim())
			p.s3_secret_access_key = form.s3_secret_access_key.trim();
		if (form.s3_cdn_token_key.trim())
			p.s3_cdn_token_key = form.s3_cdn_token_key.trim();
		return p;
	};

	// Active web-search provider + its key field/flag.
	const wsProvider = form.websearch_provider || "brave";
	const wsMeta =
		WEBSEARCH_PROVIDERS.find((p) => p.id === wsProvider) ||
		WEBSEARCH_PROVIDERS[0];
	const wsKeySet = data?.[`${wsMeta.key}_set`];

	const wsTestPayload = () => {
		const p = { provider: wsProvider };
		if (form[wsMeta.key].trim()) p.api_key = form[wsMeta.key].trim();
		return p;
	};

	const secretPlaceholder = (isSet) =>
		isSet ? "•••• configured — leave blank to keep" : "not set";

	const TestRow = ({ pending, onTest, onClear, result }) => (
		<div className="vp-svc-test">
			<PvButton size="sm" onClick={onTest} disabled={pending}>
				{pending ? "Testing…" : "Try now"}
			</PvButton>
			<PvButton
				size="sm"
				variant="danger"
				onClick={onClear}
				disabled={update.isPending}
			>
				Clear
			</PvButton>
			{result && (
				<span
					className={`vp-svc-result ${result.ok ? "is-ok" : "is-err"}`}
					title={result.message}
				>
					{result.ok ? "✓" : "✕"} {result.message}
				</span>
			)}
		</div>
	);

	return (
		<PageContent variant="narrow">
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">Services</h1>
					<p className="vp-page-subtitle">
						Connection settings for the vault's external services. Stored in the
						database — no redeploy needed.
					</p>
				</div>
			</div>

			{isLoading && <p className="vp-muted vp-text">Loading…</p>}
			{error && (
				<p className="vp-text" style={{ color: "var(--vp-accent-3)" }}>
					Failed to load service settings.
				</p>
			)}

			{data &&
				(() => {
					// Which services have credentials saved — drives the tab status dots.
					const wsAnySet = WEBSEARCH_PROVIDERS.some(
						(p) => data[`${p.key}_set`],
					);
					const configured = {
						embeddings: !!data.azure_embedding_api_key_set,
						search: wsAnySet,
						storage: !!data.s3_secret_access_key_set,
					};
					return (
						<div className="vp-stack">
							<div className="vp-svc-tabs" role="tablist">
								{TABS.map((t) => (
									<button
										key={t.id}
										type="button"
										role="tab"
										aria-selected={activeTab === t.id}
										className={`vp-svc-tab ${activeTab === t.id ? "is-active" : ""}`}
										onClick={() => setActiveTab(t.id)}
									>
										<span
											className={`vp-svc-tab-dot ${configured[t.id] ? "is-on" : "is-off"}`}
											title={configured[t.id] ? "Configured" : "Not configured"}
										/>
										{t.label}
									</button>
								))}
							</div>

							{/* Embeddings (Azure OpenAI) */}
							{activeTab === "embeddings" && (
								<PvPanel title="embeddings · azure openai">
									<p className="vp-card-desc" style={{ marginBottom: 16 }}>
										Used to generate note embeddings and embed search queries
										(text-embedding-3-large, 1536 dims).
									</p>
									<div className="vp-field">
										<span className="vp-label">Embedding URL</span>
										<input
											className="vp-input"
											type="text"
											spellCheck={false}
											placeholder="https://<resource>.openai.azure.com/openai/deployments/<deployment>/embeddings?api-version=2023-05-15"
											value={form.azure_embedding_url}
											onChange={set("azure_embedding_url")}
										/>
									</div>
									<div className="vp-field" style={{ marginBottom: 0 }}>
										<span className="vp-label">
											API Key{" "}
											{data.azure_embedding_api_key_set ? (
												<span className="vp-tag vp-tag--green vp-svc-chip">
													set
												</span>
											) : (
												<span className="vp-tag vp-tag--red vp-svc-chip">
													unset
												</span>
											)}
										</span>
										<input
											className="vp-input"
											type="password"
											autoComplete="new-password"
											placeholder={secretPlaceholder(
												data.azure_embedding_api_key_set,
											)}
											value={form.azure_embedding_api_key}
											onChange={set("azure_embedding_api_key")}
										/>
									</div>
									<TestRow
										pending={testEmb.isPending}
										onTest={() =>
											runTest(testEmb, setEmbResult, embTestPayload())
										}
										onClear={() =>
											requestClear(EMB_KEYS, setEmbResult, "Azure embedding")
										}
										result={embResult}
									/>
								</PvPanel>
							)}

							{/* Web search (agent web_search tool) — pick a provider + key. */}
							{activeTab === "search" && (
								<PvPanel title="search · web">
									<p className="vp-card-desc" style={{ marginBottom: 16 }}>
										Powers the agent's <code>web_search</code> tool. Pick a
										provider and set its API key. Swap providers anytime without
										touching the agent.
									</p>
									<div className="vp-field">
										<span className="vp-label">Provider</span>
										<select
											className="vp-input"
											value={wsProvider}
											onChange={set("websearch_provider")}
										>
											{WEBSEARCH_PROVIDERS.map((p) => (
												<option key={p.id} value={p.id}>
													{p.label}
												</option>
											))}
										</select>
									</div>
									<div className="vp-field" style={{ marginBottom: 0 }}>
										<span className="vp-label">
											{wsMeta.label} API Key{" "}
											{wsKeySet ? (
												<span className="vp-tag vp-tag--green vp-svc-chip">
													set
												</span>
											) : (
												<span className="vp-tag vp-tag--red vp-svc-chip">
													unset
												</span>
											)}
										</span>
										<input
											className="vp-input"
											type="password"
											autoComplete="new-password"
											placeholder={secretPlaceholder(wsKeySet)}
											value={form[wsMeta.key]}
											onChange={set(wsMeta.key)}
										/>
										<span className="vp-muted vp-text" style={{ fontSize: 12 }}>
											{wsMeta.hint}
										</span>
									</div>
									<TestRow
										pending={testWs.isPending}
										onTest={() => runTest(testWs, setWsResult, wsTestPayload())}
										onClear={() =>
											requestClear(
												[wsMeta.key],
												setWsResult,
												`${wsMeta.label} search`,
											)
										}
										result={wsResult}
									/>
								</PvPanel>
							)}

							{/* Object storage (S3) — pick the adapter preset, then fill it. */}
							{activeTab === "storage" && (
								<PvPanel title="storage · s3">
									<div className="vp-field">
										<span className="vp-label">Adapter</span>
										<select
											className="vp-input"
											value={vendor}
											onChange={selectVendor}
										>
											{Object.entries(VENDORS).map(([id, preset]) => (
												<option key={id} value={id}>
													{preset.label}
												</option>
											))}
										</select>
									</div>
									<p className="vp-card-desc" style={{ marginBottom: 16 }}>
										{v.desc}
									</p>
									<div className="vp-field">
										<span className="vp-label">{v.endpoint.label}</span>
										<input
											className="vp-input"
											type="text"
											spellCheck={false}
											placeholder={v.endpoint.ph}
											value={form.s3_endpoint}
											onChange={set("s3_endpoint")}
										/>
									</div>
									<div className="vp-field">
										<span className="vp-label">{v.region.label}</span>
										<input
											className="vp-input"
											type="text"
											spellCheck={false}
											placeholder={v.region.ph}
											value={form.s3_region}
											onChange={set("s3_region")}
										/>
									</div>
									{vendor === "bunny" ? (
										<div className="vp-field">
											<span className="vp-label">{v.bucket.label}</span>
											<input
												className="vp-input"
												type="text"
												spellCheck={false}
												placeholder={v.bucket.ph}
												value={form.s3_bucket}
												onChange={setZone}
											/>
										</div>
									) : (
										<>
											<div className="vp-field">
												<span className="vp-label">{v.bucket.label}</span>
												<input
													className="vp-input"
													type="text"
													spellCheck={false}
													placeholder={v.bucket.ph}
													value={form.s3_bucket}
													onChange={set("s3_bucket")}
												/>
											</div>
											<div className="vp-field">
												<span className="vp-label">{v.accessKey.label}</span>
												<input
													className="vp-input"
													type="text"
													spellCheck={false}
													placeholder={v.accessKey.ph}
													value={form.s3_access_key_id}
													onChange={set("s3_access_key_id")}
												/>
											</div>
										</>
									)}
									<div className="vp-field">
										<span className="vp-label">
											{v.secret.label}{" "}
											{data.s3_secret_access_key_set ? (
												<span className="vp-tag vp-tag--green vp-svc-chip">
													set
												</span>
											) : (
												<span className="vp-tag vp-tag--red vp-svc-chip">
													unset
												</span>
											)}
										</span>
										<input
											className="vp-input"
											type="password"
											autoComplete="new-password"
											placeholder={secretPlaceholder(
												data.s3_secret_access_key_set,
											)}
											value={form.s3_secret_access_key}
											onChange={set("s3_secret_access_key")}
										/>
									</div>

									{/* CDN — optional accelerator on top of the bucket above. */}
									<div className="vp-field">
										<span className="vp-label">
											{v.cdnUrl.label}{" "}
											<span className="vp-muted vp-svc-chip">optional</span>
										</span>
										<input
											className="vp-input"
											type="text"
											spellCheck={false}
											placeholder={v.cdnUrl.ph}
											value={form.s3_cdn_url}
											onChange={set("s3_cdn_url")}
										/>
									</div>
									<div className="vp-field">
										<span className="vp-label">
											{v.cdnToken.label}{" "}
											<span className="vp-muted vp-svc-chip">optional</span>
											{data.s3_cdn_token_key_set && (
												<span className="vp-tag vp-tag--green vp-svc-chip">
													set
												</span>
											)}
										</span>
										<input
											className="vp-input"
											type="password"
											autoComplete="new-password"
											placeholder={secretPlaceholder(data.s3_cdn_token_key_set)}
											value={form.s3_cdn_token_key}
											onChange={set("s3_cdn_token_key")}
										/>
									</div>
									<TestRow
										pending={testS3.isPending}
										onTest={() => runTest(testS3, setS3Result, s3TestPayload())}
										onClear={() =>
											requestClear(S3_KEYS, setS3Result, "storage")
										}
										result={s3Result}
									/>
								</PvPanel>
							)}

							<div className="vp-row" style={{ justifyContent: "flex-end" }}>
								<PvButton
									variant="primary"
									onClick={handleSave}
									disabled={update.isPending}
								>
									{update.isPending ? "Saving…" : "Save changes"}
								</PvButton>
							</div>
						</div>
					);
				})()}

			<PvModal
				open={!!confirmClear}
				title="Clear credentials?"
				danger
				confirmText="Clear"
				cancelText="Cancel"
				onConfirm={confirmClearNow}
				onCancel={() => setConfirmClear(null)}
			>
				<p className="vp-text">
					This permanently removes the saved{" "}
					<strong>{confirmClear?.label}</strong> credentials and disconnects the
					service until you re-enter them. This cannot be undone.
				</p>
			</PvModal>
		</PageContent>
	);
};

export default Services;
