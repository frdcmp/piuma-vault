import { ReloadOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";
import {
	PvButton,
	PvField,
	PvIconButton,
	PvInput,
	PvModal,
	PvPanel,
	PvSelect,
	PvTable,
	pvMessage,
} from "@/ui";
import {
	useAllNoteShares,
	useDeleteFolderShare,
	useFolderShares,
	useRenewFolderShare,
	useRenewNoteShare,
	useRevokeNoteShare,
	useUpdateFolderShare,
	useUpdateNoteShare,
} from "../../../queries";
import { formatDateTime, timeAgo } from "../../../utils/dateTime";
import { PageContent } from "../../components/layout/PageLayout";
import "./shares.css";

const TYPE_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "note", label: "Notes" },
	{ value: "folder", label: "Folders" },
];
const STATUS_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "active", label: "Active" },
	{ value: "disabled", label: "Disabled" },
];
const PASSWORD_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "protected", label: "Protected" },
	{ value: "none", label: "No password" },
];
const EXPIRY_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "expiring", label: "Expiring" },
	{ value: "expired", label: "Expired" },
	{ value: "never", label: "Never" },
];

// Prepend the current origin to a relative URL returned by the backend.
const absoluteUrl = (url) => {
	if (!url) return "";
	if (/^https?:\/\//.test(url)) return url;
	return `${window.location.origin}${url.startsWith("/") ? "" : "/"}${url}`;
};

// Comparable value for a row under a given sort key.
const sortValue = (row, key) => {
	switch (key) {
		case "name":
			return (row.name || "").toLowerCase();
		case "type":
			return row.type;
		case "access":
			return row.access_level || "";
		case "password":
			return row.has_password ? 1 : 0;
		case "status":
			return row.is_active ? 1 : 0;
		case "created":
			return row.created_at ? new Date(row.created_at).getTime() : 0;
		case "expires":
			// "Never" sorts last in ascending order.
			return row.expires_at
				? new Date(row.expires_at).getTime()
				: Number.POSITIVE_INFINITY;
		default:
			return 0;
	}
};

// Column sorter (PvTable) over `sortValue`.
const sortBy = (key) => (a, b) => {
	const av = sortValue(a, key);
	const bv = sortValue(b, key);
	return av < bv ? -1 : av > bv ? 1 : 0;
};

const SharesPage = () => {
	const notesQuery = useAllNoteShares();
	const foldersQuery = useFolderShares(undefined);
	const revokeNote = useRevokeNoteShare();
	const updateNote = useUpdateNoteShare();
	const renewNote = useRenewNoteShare();
	const deleteFolder = useDeleteFolderShare();
	const updateFolder = useUpdateFolderShare();
	const renewFolder = useRenewFolderShare();

	const [pendingRevoke, setPendingRevoke] = useState(null);

	// Filters + sort state.
	const [search, setSearch] = useState("");
	const [typeFilter, setTypeFilter] = useState("all");
	const [statusFilter, setStatusFilter] = useState("all");
	const [pwdFilter, setPwdFilter] = useState("all");
	const [expiryFilter, setExpiryFilter] = useState("all");

	const loading = notesQuery.isLoading || foldersQuery.isLoading;

	// Merge note + folder shares into one list.
	const rows = useMemo(() => {
		const noteRows = (notesQuery.data || []).map((s) => ({
			key: `note-${s.id}`,
			id: s.id,
			type: "note",
			name: s.note_title?.trim() || "Untitled",
			url: `${window.location.origin}/share/v/${s.slug}`,
			slug: s.slug,
			access_level: s.access_level,
			has_password: s.has_password,
			password: s.password || null,
			is_active: s.is_active,
			expires_at: s.expires_at,
			created_at: s.created_at,
		}));
		const folderRows = (foldersQuery.data || []).map((s) => ({
			key: `folder-${s.id}`,
			id: s.id,
			type: "folder",
			name: s.prefix || "/",
			url: absoluteUrl(s.url),
			slug: s.slug,
			access_level: s.access_level,
			has_password: s.has_password,
			password: null, // folder share passwords are hash-only (not recoverable)
			is_active: s.is_active,
			expires_at: s.expires_at,
			created_at: s.created_at,
		}));
		return [...noteRows, ...folderRows];
	}, [notesQuery.data, foldersQuery.data]);

	// Apply filters; newest first until a column header picks another order.
	const visible = useMemo(() => {
		const now = Date.now();
		const q = search.trim().toLowerCase();
		const filtered = rows.filter((r) => {
			if (typeFilter !== "all" && r.type !== typeFilter) return false;
			if (statusFilter === "active" && !r.is_active) return false;
			if (statusFilter === "disabled" && r.is_active) return false;
			if (pwdFilter === "protected" && !r.has_password) return false;
			if (pwdFilter === "none" && r.has_password) return false;
			if (expiryFilter !== "all") {
				const exp = r.expires_at ? new Date(r.expires_at).getTime() : null;
				if (expiryFilter === "never" && exp !== null) return false;
				if (expiryFilter === "expiring" && !(exp !== null && exp >= now))
					return false;
				if (expiryFilter === "expired" && !(exp !== null && exp < now))
					return false;
			}
			if (q && !`${r.name} ${r.slug}`.toLowerCase().includes(q)) return false;
			return true;
		});
		const byCreated = sortBy("created");
		return [...filtered].sort((a, b) => byCreated(b, a));
	}, [rows, search, typeFilter, statusFilter, pwdFilter, expiryFilter]);

	const copy = async (text, label) => {
		try {
			await navigator.clipboard.writeText(text);
			pvMessage.success(`${label} copied`);
		} catch {
			pvMessage.error("Failed to copy");
		}
	};

	// LLM/API URL for a note share — the markdown API endpoint, with the
	// password embedded (an API consumer can't be prompted). Notes only.
	const llmUrl = (row) => {
		const apiBase = `${import.meta.env.BASE_URL || "/"}api/v1`;
		const base = `${window.location.origin}${apiBase}/share/v/${row.slug}`;
		return row.has_password && row.password
			? `${base}?pwd=${encodeURIComponent(row.password)}`
			: base;
	};

	const renew = (row) => {
		const opts = {
			onSuccess: () => pvMessage.success("Share renewed"),
			onError: () => pvMessage.error("Failed to renew share"),
		};
		if (row.type === "note") renewNote.mutate(row.id, opts);
		else renewFolder.mutate(row.id, opts);
	};

	const toggleActive = (row) => {
		const updates = { is_active: !row.is_active };
		const onSuccess = () =>
			pvMessage.success(row.is_active ? "Share disabled" : "Share enabled");
		const onError = () => pvMessage.error("Failed to update share");
		if (row.type === "note") {
			updateNote.mutate({ id: row.id, updates }, { onSuccess, onError });
		} else {
			updateFolder.mutate({ id: row.id, ...updates }, { onSuccess, onError });
		}
	};

	const confirmRevoke = () => {
		const row = pendingRevoke;
		if (!row) return;
		const opts = {
			onSuccess: () => pvMessage.success("Share revoked"),
			onError: () => pvMessage.error("Failed to revoke share"),
		};
		if (row.type === "note") revokeNote.mutate(row.id, opts);
		else deleteFolder.mutate(row.id, opts);
		setPendingRevoke(null);
	};

	const renderExpiry = (v) => {
		if (!v) return <span className="vp-faint">Never</span>;
		if (new Date(v) - Date.now() < 0)
			return <span className="vp-accent">Expired</span>;
		const { date, time } = formatDateTime(v);
		return <span title={`${date} ${time}`}>{timeAgo(v)}</span>;
	};

	const columns = [
		{
			key: "type",
			title: "Type",
			dataIndex: "type",
			sorter: sortBy("type"),
			render: (type) => (
				<span className={`vp-tag sh-type--${type}`}>
					{type === "note" ? "📝 Note" : "📁 Folder"}
				</span>
			),
		},
		{
			key: "name",
			title: "Name",
			dataIndex: "name",
			sorter: sortBy("name"),
			render: (name, row) => (
				<code className="sh-name" title={`${name} · /${row.slug}`}>
					{name}
				</code>
			),
		},
		{
			key: "access",
			title: "Access",
			dataIndex: "access_level",
			sorter: sortBy("access"),
			render: (lvl) => <span className="vp-tag">{lvl}</span>,
		},
		{
			key: "password",
			title: "Password",
			align: "center",
			sorter: sortBy("password"),
			render: (_v, row) => {
				if (!row.has_password) return <span title="No password">🔓</span>;
				if (row.password) {
					return (
						<PvIconButton
							variant="ghost"
							size="sm"
							icon="🔒"
							label={`Password: ${row.password} — click to copy`}
							onClick={() => copy(row.password, "Password")}
						/>
					);
				}
				return <span title="Password-protected">🔒</span>;
			},
		},
		{
			key: "created",
			title: "Created",
			dataIndex: "created_at",
			sorter: sortBy("created"),
			render: (v) =>
				v ? (
					<span title={`${formatDateTime(v).date} ${formatDateTime(v).time}`}>
						{timeAgo(v)}
					</span>
				) : (
					<span className="vp-faint">—</span>
				),
		},
		{
			key: "expires",
			title: "Expires",
			dataIndex: "expires_at",
			sorter: sortBy("expires"),
			render: renderExpiry,
		},
		{
			key: "status",
			title: "Status",
			dataIndex: "is_active",
			sorter: sortBy("status"),
			render: (active, row) => (
				<button
					type="button"
					onClick={() => toggleActive(row)}
					className={`vp-tag sh-status-toggle ${active ? "vp-tag--green" : ""}`}
					title={active ? "Click to disable" : "Click to enable"}
				>
					{active ? "Active" : "Disabled"}
				</button>
			),
		},
		{
			key: "actions",
			title: "Actions",
			align: "right",
			render: (_v, row) => (
				<div className="vp-row sh-actions">
					<PvButton size="sm" onClick={() => copy(row.url, "Link")}>
						Copy link
					</PvButton>
					{row.type === "note" && (
						<PvButton
							size="sm"
							onClick={() => copy(llmUrl(row), "LLM URL")}
							title="Copy the markdown API URL (password embedded)"
						>
							Copy LLM
						</PvButton>
					)}
					<PvButton
						size="sm"
						onClick={() => renew(row)}
						title="Reset created date to now and extend expiry by its original lifespan"
					>
						Renew
					</PvButton>
					<PvButton
						size="sm"
						variant="danger"
						onClick={() => setPendingRevoke(row)}
					>
						Revoke
					</PvButton>
				</div>
			),
		},
	];

	return (
		<PageContent>
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">Shares</h1>
					<p className="vp-page-subtitle">
						Every active share link across your notes and folders. Review
						access, copy or reveal passwords, disable, or revoke.
					</p>
				</div>
				<div className="vp-row vp-row--wrap">
					<PvButton
						icon={<ReloadOutlined />}
						onClick={() => {
							notesQuery.refetch();
							foldersQuery.refetch();
						}}
						disabled={loading}
					>
						Refresh
					</PvButton>
				</div>
			</div>

			{/* Filter bar */}
			<div className="vp-row vp-row--wrap sh-filters">
				<PvField label="Search" className="sh-filter-search">
					<PvInput
						placeholder="Name or slug…"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</PvField>
				<PvField label="Type">
					<PvSelect
						options={TYPE_FILTERS}
						value={typeFilter}
						onChange={setTypeFilter}
					/>
				</PvField>
				<PvField label="Status">
					<PvSelect
						options={STATUS_FILTERS}
						value={statusFilter}
						onChange={setStatusFilter}
					/>
				</PvField>
				<PvField label="Password">
					<PvSelect
						options={PASSWORD_FILTERS}
						value={pwdFilter}
						onChange={setPwdFilter}
					/>
				</PvField>
				<PvField label="Expiry">
					<PvSelect
						options={EXPIRY_FILTERS}
						value={expiryFilter}
						onChange={setExpiryFilter}
					/>
				</PvField>
			</div>

			<PvPanel
				title={`shares.table — ${visible.length} of ${rows.length}`}
				noPad
			>
				<PvTable
					columns={columns}
					data={visible}
					rowKey="key"
					loading={loading}
					emptyText="No shares match your filters"
				/>
			</PvPanel>

			<PvModal
				open={pendingRevoke != null}
				title="Revoke share"
				confirmText="Revoke"
				cancelText="Cancel"
				danger
				onConfirm={confirmRevoke}
				onCancel={() => setPendingRevoke(null)}
			>
				<p className="vp-text">
					Revoke the {pendingRevoke?.type} share for{" "}
					<strong>{pendingRevoke?.name}</strong>? The link will stop working
					immediately and can't be restored.
				</p>
			</PvModal>
		</PageContent>
	);
};

export default SharesPage;
