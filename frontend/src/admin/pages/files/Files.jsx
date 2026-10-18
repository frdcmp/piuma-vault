import {
	CloudUploadOutlined,
	DeleteOutlined,
	DownloadOutlined,
	FileOutlined,
	FileZipOutlined,
	FolderOpenOutlined,
	FolderOutlined,
	HomeOutlined,
	InboxOutlined,
	LinkOutlined,
	ReloadOutlined,
	ShareAltOutlined,
} from "@ant-design/icons";
import { useMemo, useState } from "react";
import {
	PvButton,
	PvCheckbox,
	PvEmpty,
	PvField,
	PvInput,
	PvModal,
	PvPanel,
	PvSelect,
	PvSpin,
	PvUpload,
	pvConfirm,
	pvMessage,
} from "@/ui";
import {
	useStorageBulkDelete,
	useStorageDeleteFolder,
	useStorageDeleteObject,
	useStorageDownload,
	useStorageList,
	useStorageSignedUrl,
	useStorageUpload,
	useStorageZip,
} from "../../../queries";
import { formatDate } from "../../../utils/dateTime";
import { PageContent } from "../../components/layout/PageLayout";
import "./files.css";

const formatBytes = (n) => {
	if (!n) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(n) / Math.log(1024));
	return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

// Backend returns folder keys like "docs/2026/", which display nicer trimmed.
const folderLeaf = (path) => {
	const trimmed = path.replace(/\/$/, "");
	return trimmed.split("/").pop() || "/";
};

const fileLeaf = (key) => key.split("/").pop() || key;

const EXPIRY_OPTIONS = [
	{ value: 300, label: "5 minutes" },
	{ value: 3600, label: "1 hour" },
	{ value: 86400, label: "1 day" },
	{ value: 604800, label: "7 days" },
];

const StatCard = ({ label, value, icon }) => (
	<div className="vp-files-stat">
		<div>
			<span className="vp-files-stat-label">{label}</span>
			<div className="vp-files-stat-value">{value}</div>
		</div>
		<span className="vp-files-stat-icon">{icon}</span>
	</div>
);

const Files = () => {
	// Current folder being explored. `""` = zone root. Always ends with `/`
	// when non-empty so prefix-based listing works cleanly.
	const [prefix, setPrefix] = useState("");
	const [selected, setSelected] = useState(new Set());

	const list = useStorageList({ prefix });
	const upload = useStorageUpload();
	const deleteObject = useStorageDeleteObject();
	const deleteFolder = useStorageDeleteFolder();
	const bulkDelete = useStorageBulkDelete();
	const download = useStorageDownload();
	const zip = useStorageZip();
	const signed = useStorageSignedUrl();

	// Share-link modal state.
	const [shareKey, setShareKey] = useState(null);
	const [shareExpiry, setShareExpiry] = useState(3600);
	const [shareUrl, setShareUrl] = useState("");

	const folders = list.data?.folders || [];
	const files = list.data?.files || [];
	const cdnBase = list.data?.cdn_base || "";
	const isEmpty = !list.isLoading && folders.length === 0 && files.length === 0;
	const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);

	const copyCdnUrl = async (key) => {
		if (!cdnBase) {
			pvMessage.warning("No CDN URL configured (set BUNNY_CDN_URL).");
			return;
		}
		const url = `${cdnBase}/${key}`;
		try {
			await navigator.clipboard.writeText(url);
			pvMessage.success("CDN URL copied");
		} catch {
			pvMessage.error("Could not copy to clipboard");
		}
	};

	const openShare = (key) => {
		setShareKey(key);
		setShareExpiry(3600);
		setShareUrl("");
	};

	const closeShare = () => {
		setShareKey(null);
		setShareUrl("");
	};

	const generateShareLink = async () => {
		try {
			const res = await signed.mutateAsync({
				key: shareKey,
				expiresInSecs: shareExpiry,
			});
			setShareUrl(res.url);
		} catch (e) {
			pvMessage.error(`Failed to generate link: ${e.message}`);
		}
	};

	const copyShareLink = async () => {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			pvMessage.success("Share link copied");
		} catch {
			pvMessage.error("Could not copy to clipboard");
		}
	};

	// Breadcrumb segments. Empty prefix → just root.
	const crumbs = useMemo(() => {
		const trimmed = prefix.replace(/\/$/, "");
		if (!trimmed) return [];
		const segments = trimmed.split("/");
		return segments.map((seg, i) => ({
			name: seg,
			path: `${segments.slice(0, i + 1).join("/")}/`,
		}));
	}, [prefix]);

	const clearSelection = () => setSelected(new Set());

	const goToFolder = (folderKey) => {
		setPrefix(folderKey);
		clearSelection();
	};

	const goUp = (path) => {
		setPrefix(path);
		clearSelection();
	};

	const toggleOne = (key) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const toggleAllFiles = (checked) => {
		setSelected(checked ? new Set(files.map((f) => f.key)) : new Set());
	};

	const handleUpload = async (file) => {
		try {
			await upload.mutateAsync({ file, path: prefix });
			pvMessage.success(`${file.name} uploaded`);
		} catch (e) {
			pvMessage.error(
				`Upload failed: ${e?.response?.data?.message || e.message}`,
			);
		}
	};

	const handleDeleteFile = async (key) => {
		const ok = await pvConfirm({
			title: "Delete file?",
			content: key,
			okText: "Delete",
			danger: true,
		});
		if (!ok) return;
		try {
			await deleteObject.mutateAsync(key);
			setSelected((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
			pvMessage.success("Deleted");
		} catch (e) {
			pvMessage.error(`Delete failed: ${e.message}`);
		}
	};

	const handleDeleteFolder = async (folderKey) => {
		const ok = await pvConfirm({
			title: "Delete folder and all contents?",
			content: folderKey,
			okText: "Delete",
			danger: true,
		});
		if (!ok) return;
		try {
			await deleteFolder.mutateAsync(folderKey);
			pvMessage.success("Folder deleted");
		} catch (e) {
			pvMessage.error(`Delete failed: ${e.message}`);
		}
	};

	const handleBulkDelete = async () => {
		const keys = Array.from(selected);
		if (keys.length === 0) return;
		const ok = await pvConfirm({
			title: `Delete ${keys.length} file${keys.length === 1 ? "" : "s"}?`,
			okText: "Delete",
			danger: true,
		});
		if (!ok) return;
		try {
			const res = await bulkDelete.mutateAsync(keys);
			pvMessage.success(`Deleted ${res.deleted?.length ?? 0}`);
			if (res.failed?.length) {
				pvMessage.warning(`${res.failed.length} failed`);
			}
			clearSelection();
		} catch (e) {
			pvMessage.error(`Bulk delete failed: ${e.message}`);
		}
	};

	const handleDownloadSelected = async () => {
		const keys = Array.from(selected);
		if (keys.length === 0) return;
		try {
			await zip.mutateAsync({
				keys,
				filename: prefix ? folderLeaf(prefix) : "bundle",
			});
		} catch (e) {
			pvMessage.error(`Zip failed: ${e.message}`);
		}
	};

	const handleDownloadFolder = async () => {
		try {
			await zip.mutateAsync({
				prefix,
				filename: prefix ? folderLeaf(prefix) : "root",
			});
		} catch (e) {
			pvMessage.error(`Zip failed: ${e.message}`);
		}
	};

	const stats = [
		{
			title: "Items here",
			value: `${folders.length + files.length}`,
			icon: <FileOutlined className="vp-files-stat-glyph" />,
		},
		{
			title: "Size in this folder",
			value: formatBytes(totalSize),
			icon: (
				<FolderOpenOutlined className="vp-files-stat-glyph vp-files-stat-glyph--green" />
			),
		},
		{
			title: "Storage",
			value: "Bunny (sg)",
			icon: (
				<CloudUploadOutlined className="vp-files-stat-glyph vp-files-stat-glyph--accent" />
			),
		},
	];

	const allFilesSelected =
		files.length > 0 && files.every((f) => selected.has(f.key));
	const someFilesSelected = files.some((f) => selected.has(f.key));

	const expiryLabel =
		shareExpiry === 300
			? "5 minutes"
			: shareExpiry === 3600
				? "1 hour"
				: shareExpiry === 86400
					? "1 day"
					: "7 days";

	return (
		<PageContent>
			<div className="vp-page">
				{/* Header */}
				<div className="vp-page-head">
					<div>
						<h1 className="vp-page-title">File Storage</h1>
						<p className="vp-page-subtitle">
							Bunny S3-compatible storage (zone: your-zone)
						</p>
					</div>
					<div className="vp-row vp-row--wrap">
						<PvButton
							icon={<FileZipOutlined />}
							onClick={handleDownloadFolder}
							disabled={isEmpty || zip.isPending}
						>
							Download folder as .zip
						</PvButton>
						<PvButton
							icon={<ReloadOutlined />}
							onClick={() => list.refetch()}
							disabled={list.isFetching}
						>
							Refresh
						</PvButton>
					</div>
				</div>

				<div className="vp-stack">
					{/* Stats */}
					<div className="vp-files-stats">
						{stats.map((s) => (
							<StatCard
								key={s.title}
								label={s.title}
								value={s.value}
								icon={s.icon}
							/>
						))}
					</div>

					{/* Upload */}
					<PvPanel
						title={
							<>
								<CloudUploadOutlined /> Upload to {prefix || "/"}
							</>
						}
						bodyClassName="vp-files-upload"
					>
						<PvUpload
							drag
							multiple
							onFiles={(picked) => picked.forEach(handleUpload)}
							disabled={upload.isPending}
						>
							<InboxOutlined className="vp-files-upload-icon" />
							<span className="vp-files-upload-text">
								Click or drag files here to upload
							</span>
							<span className="vp-files-upload-hint">
								Multiple files supported. Files land in the current folder.
							</span>
						</PvUpload>
					</PvPanel>

					{/* Browser */}
					<PvPanel title="Browse">
						{/* Breadcrumb */}
						<div className="vp-files-crumbs">
							<button
								type="button"
								className="vp-files-crumb"
								onClick={() => goUp("")}
							>
								<HomeOutlined /> root
							</button>
							{crumbs.map((c) => (
								<span key={c.path} className="vp-files-crumb-wrap">
									<span className="vp-files-crumb-sep">/</span>
									<button
										type="button"
										className="vp-files-crumb"
										onClick={() => goUp(c.path)}
									>
										{c.name}
									</button>
								</span>
							))}
						</div>

						{/* Bulk actions toolbar */}
						{selected.size > 0 && (
							<div className="vp-files-bulkbar">
								<span className="vp-text">{selected.size} selected</span>
								<div className="vp-row vp-row--wrap">
									<PvButton
										size="sm"
										icon={<FileZipOutlined />}
										onClick={handleDownloadSelected}
										disabled={zip.isPending}
									>
										Download .zip
									</PvButton>
									<PvButton
										size="sm"
										variant="danger"
										icon={<DeleteOutlined />}
										onClick={handleBulkDelete}
										disabled={bulkDelete.isPending}
									>
										Delete
									</PvButton>
									<PvButton size="sm" onClick={clearSelection}>
										Clear
									</PvButton>
								</div>
							</div>
						)}

						{list.isLoading ? (
							<PvSpin block />
						) : isEmpty ? (
							<PvEmpty description={`No items in ${prefix || "/"}`}>
								<p className="vp-muted vp-text">
									Upload a file or drill into a folder via the breadcrumb above.
								</p>
							</PvEmpty>
						) : (
							<>
								{/* Select-all for files in the current view */}
								{files.length > 0 && (
									<div className="vp-files-selectall">
										<PvCheckbox
											checked={allFilesSelected}
											indeterminate={someFilesSelected && !allFilesSelected}
											onChange={toggleAllFiles}
											label={`Select all files (${files.length})`}
										/>
									</div>
								)}

								<ul className="vp-files-list">
									{folders.map((folderKey) => (
										<li
											key={`f-${folderKey}`}
											className="vp-files-item vp-files-item--folder"
										>
											<button
												type="button"
												className="vp-files-item-main"
												onClick={() => goToFolder(folderKey)}
											>
												<FolderOutlined className="vp-files-avatar vp-files-avatar--folder" />
												<span className="vp-files-item-text">
													<span className="vp-files-name">
														{folderLeaf(folderKey)}
													</span>
													<span className="vp-files-meta">{folderKey}</span>
												</span>
											</button>
											<div className="vp-files-item-actions">
												<PvButton
													size="sm"
													variant="ghost"
													icon={<FileZipOutlined />}
													onClick={async () => {
														try {
															await zip.mutateAsync({
																prefix: folderKey,
																filename: folderLeaf(folderKey),
															});
														} catch (err) {
															pvMessage.error(`Zip failed: ${err.message}`);
														}
													}}
													disabled={zip.isPending}
												>
													.zip
												</PvButton>
												<PvButton
													size="sm"
													variant="danger"
													icon={<DeleteOutlined />}
													onClick={() => handleDeleteFolder(folderKey)}
													disabled={deleteFolder.isPending}
												>
													Delete
												</PvButton>
											</div>
										</li>
									))}
									{files.map((item) => (
										<li key={`o-${item.key}`} className="vp-files-item">
											<div className="vp-files-item-main">
												<PvCheckbox
													checked={selected.has(item.key)}
													onChange={() => toggleOne(item.key)}
													aria-label={`Select ${fileLeaf(item.key)}`}
												/>
												<span className="vp-files-item-text">
													<span className="vp-row vp-files-title">
														<FileOutlined className="vp-files-avatar" />
														<span className="vp-files-name">
															{fileLeaf(item.key)}
														</span>
														<span className="vp-tag vp-tag--blue">
															{formatBytes(item.size)}
														</span>
													</span>
													<span className="vp-files-meta">{item.key}</span>
													{item.last_modified && (
														<span className="vp-files-meta">
															{formatDate(item.last_modified)}
														</span>
													)}
												</span>
											</div>
											<div className="vp-files-item-actions">
												<PvButton
													size="sm"
													variant="ghost"
													icon={<DownloadOutlined />}
													onClick={() => download.mutate(item.key)}
													disabled={download.isPending}
												>
													Download
												</PvButton>
												<PvButton
													size="sm"
													variant="ghost"
													icon={<LinkOutlined />}
													onClick={() => copyCdnUrl(item.key)}
													disabled={!cdnBase}
												>
													Copy URL
												</PvButton>
												<PvButton
													size="sm"
													variant="ghost"
													icon={<ShareAltOutlined />}
													onClick={() => openShare(item.key)}
												>
													Share
												</PvButton>
												<PvButton
													size="sm"
													variant="danger"
													icon={<DeleteOutlined />}
													onClick={() => handleDeleteFile(item.key)}
													disabled={deleteObject.isPending}
												>
													Delete
												</PvButton>
											</div>
										</li>
									))}
								</ul>
							</>
						)}
					</PvPanel>
				</div>

				{/* Share modal — generates a Bunny URL-Token-Auth signed CDN link */}
				<PvModal
					title="Share file"
					open={!!shareKey}
					onCancel={closeShare}
					width={520}
					footer={<PvButton onClick={closeShare}>Close</PvButton>}
				>
					<div className="vp-stack">
						<div>
							<span className="vp-label">File</span>
							<div className="vp-text vp-files-sharekey">{shareKey}</div>
						</div>
						<PvField label="Expires in">
							<PvSelect
								value={shareExpiry}
								onChange={setShareExpiry}
								options={EXPIRY_OPTIONS}
							/>
						</PvField>
						<PvButton
							variant="primary"
							block
							icon={<ShareAltOutlined />}
							onClick={generateShareLink}
							disabled={signed.isPending}
						>
							Generate share link
						</PvButton>
						{shareUrl ? (
							<PvField as="div" label="Signed URL">
								<div className="vp-row vp-files-shareurl">
									<PvInput value={shareUrl} readOnly aria-label="Signed URL" />
									<PvButton
										variant="primary"
										icon={<LinkOutlined />}
										onClick={copyShareLink}
									>
										Copy
									</PvButton>
								</div>
								<span className="vp-muted vp-files-shareexpiry">
									This link will expire in {expiryLabel}.
								</span>
							</PvField>
						) : null}
					</div>
				</PvModal>
			</div>
		</PageContent>
	);
};

export default Files;
