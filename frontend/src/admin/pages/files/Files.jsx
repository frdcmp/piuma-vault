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
import {
	Checkbox,
	Empty,
	Input,
	List,
	Modal,
	message,
	Select,
	Spin,
	Upload,
} from "antd";
import { useMemo, useState } from "react";
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
import { PvButton } from "../../components/ui";
import "../../vault-pixel.css";
import "./files.css";

const { Dragger } = Upload;

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
			message.warning("No CDN URL configured (set BUNNY_CDN_URL).");
			return;
		}
		const url = `${cdnBase}/${key}`;
		try {
			await navigator.clipboard.writeText(url);
			message.success("CDN URL copied");
		} catch {
			message.error("Could not copy to clipboard");
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
			message.error(`Failed to generate link: ${e.message}`);
		}
	};

	const copyShareLink = async () => {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			message.success("Share link copied");
		} catch {
			message.error("Could not copy to clipboard");
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
			message.success(`${file.name} uploaded`);
		} catch (e) {
			message.error(
				`Upload failed: ${e?.response?.data?.message || e.message}`,
			);
		}
		// Returning false prevents antd's default XHR upload.
		return false;
	};

	const handleDeleteFile = (key) => {
		Modal.confirm({
			title: "Delete file?",
			content: key,
			okType: "danger",
			okText: "Delete",
			onOk: async () => {
				try {
					await deleteObject.mutateAsync(key);
					setSelected((prev) => {
						const next = new Set(prev);
						next.delete(key);
						return next;
					});
					message.success("Deleted");
				} catch (e) {
					message.error(`Delete failed: ${e.message}`);
				}
			},
		});
	};

	const handleDeleteFolder = (folderKey) => {
		Modal.confirm({
			title: "Delete folder and all contents?",
			content: folderKey,
			okType: "danger",
			okText: "Delete",
			onOk: async () => {
				try {
					await deleteFolder.mutateAsync(folderKey);
					message.success("Folder deleted");
				} catch (e) {
					message.error(`Delete failed: ${e.message}`);
				}
			},
		});
	};

	const handleBulkDelete = () => {
		const keys = Array.from(selected);
		if (keys.length === 0) return;
		Modal.confirm({
			title: `Delete ${keys.length} file${keys.length === 1 ? "" : "s"}?`,
			okType: "danger",
			okText: "Delete",
			onOk: async () => {
				try {
					const res = await bulkDelete.mutateAsync(keys);
					message.success(`Deleted ${res.deleted?.length ?? 0}`);
					if (res.failed?.length) {
						message.warning(`${res.failed.length} failed`);
					}
					clearSelection();
				} catch (e) {
					message.error(`Bulk delete failed: ${e.message}`);
				}
			},
		});
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
			message.error(`Zip failed: ${e.message}`);
		}
	};

	const handleDownloadFolder = async () => {
		try {
			await zip.mutateAsync({
				prefix,
				filename: prefix ? folderLeaf(prefix) : "root",
			});
		} catch (e) {
			message.error(`Zip failed: ${e.message}`);
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
	const someFilesSelected =
		!allFilesSelected && files.some((f) => selected.has(f.key));

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
					<section className="vp-panel">
						<header className="vp-panel-bar">
							<span className="vp-dots">
								<span />
								<span />
								<span />
							</span>
							<h3 className="vp-panel-title">
								<CloudUploadOutlined /> Upload to {prefix || "/"}
							</h3>
						</header>
						<div className="vp-panel-body vp-files-upload">
							<Dragger
								name="file"
								multiple
								beforeUpload={handleUpload}
								showUploadList={false}
								disabled={upload.isPending}
							>
								<p className="ant-upload-drag-icon">
									<InboxOutlined />
								</p>
								<p className="ant-upload-text">
									Click or drag files here to upload
								</p>
								<p className="ant-upload-hint">
									Multiple files supported. Files land in the current folder.
								</p>
							</Dragger>
						</div>
					</section>

					{/* Browser */}
					<section className="vp-panel">
						<header className="vp-panel-bar">
							<span className="vp-dots">
								<span />
								<span />
								<span />
							</span>
							<h3 className="vp-panel-title">Browse</h3>
						</header>
						<div className="vp-panel-body">
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
								<div className="vp-files-center">
									<Spin size="large" />
								</div>
							) : isEmpty ? (
								<Empty
									description={`No items in ${prefix || "/"}`}
									image={Empty.PRESENTED_IMAGE_SIMPLE}
								>
									<p className="vp-muted vp-text">
										Upload a file or drill into a folder via the breadcrumb
										above.
									</p>
								</Empty>
							) : (
								<>
									{/* Select-all for files in the current view */}
									{files.length > 0 && (
										<div className="vp-files-selectall">
											<Checkbox
												checked={allFilesSelected}
												indeterminate={someFilesSelected}
												onChange={(e) => toggleAllFiles(e.target.checked)}
											>
												Select all files ({files.length})
											</Checkbox>
										</div>
									)}

									<List
										className="vp-files-list"
										dataSource={[
											...folders.map((f) => ({ kind: "folder", key: f })),
											...files.map((f) => ({ kind: "file", ...f })),
										]}
										renderItem={(item) => {
											if (item.kind === "folder") {
												return (
													<List.Item
														key={`f-${item.key}`}
														actions={[
															<PvButton
																key="zip"
																size="sm"
																variant="ghost"
																icon={<FileZipOutlined />}
																onClick={async (e) => {
																	e.stopPropagation();
																	try {
																		await zip.mutateAsync({
																			prefix: item.key,
																			filename: folderLeaf(item.key),
																		});
																	} catch (err) {
																		message.error(`Zip failed: ${err.message}`);
																	}
																}}
																disabled={zip.isPending}
															>
																.zip
															</PvButton>,
															<PvButton
																key="del"
																size="sm"
																variant="danger"
																icon={<DeleteOutlined />}
																onClick={(e) => {
																	e.stopPropagation();
																	handleDeleteFolder(item.key);
																}}
																disabled={deleteFolder.isPending}
															>
																Delete
															</PvButton>,
														]}
														onClick={() => goToFolder(item.key)}
														className="vp-files-item vp-files-item--folder"
													>
														<List.Item.Meta
															avatar={
																<FolderOutlined className="vp-files-avatar vp-files-avatar--folder" />
															}
															title={
																<span className="vp-files-name">
																	{folderLeaf(item.key)}
																</span>
															}
															description={
																<span className="vp-files-meta">
																	{item.key}
																</span>
															}
														/>
													</List.Item>
												);
											}
											const name = fileLeaf(item.key);
											return (
												<List.Item
													key={`o-${item.key}`}
													className="vp-files-item"
													actions={[
														<PvButton
															key="dl"
															size="sm"
															variant="ghost"
															icon={<DownloadOutlined />}
															onClick={() => download.mutate(item.key)}
															disabled={download.isPending}
														>
															Download
														</PvButton>,
														<PvButton
															key="url"
															size="sm"
															variant="ghost"
															icon={<LinkOutlined />}
															onClick={() => copyCdnUrl(item.key)}
															disabled={!cdnBase}
														>
															Copy URL
														</PvButton>,
														<PvButton
															key="share"
															size="sm"
															variant="ghost"
															icon={<ShareAltOutlined />}
															onClick={() => openShare(item.key)}
														>
															Share
														</PvButton>,
														<PvButton
															key="del"
															size="sm"
															variant="danger"
															icon={<DeleteOutlined />}
															onClick={() => handleDeleteFile(item.key)}
															disabled={deleteObject.isPending}
														>
															Delete
														</PvButton>,
													]}
												>
													<List.Item.Meta
														avatar={
															<Checkbox
																checked={selected.has(item.key)}
																onChange={() => toggleOne(item.key)}
															/>
														}
														title={
															<span className="vp-row vp-files-title">
																<FileOutlined className="vp-files-avatar" />
																<span className="vp-files-name">{name}</span>
																<span className="vp-tag vp-tag--blue">
																	{formatBytes(item.size)}
																</span>
															</span>
														}
														description={
															<span className="vp-files-meta-stack">
																<span className="vp-files-meta">
																	{item.key}
																</span>
																{item.last_modified && (
																	<span className="vp-files-meta">
																		{formatDate(item.last_modified)}
																	</span>
																)}
															</span>
														}
													/>
												</List.Item>
											);
										}}
									/>
								</>
							)}
						</div>
					</section>
				</div>

				{/* Share modal — generates a Bunny URL-Token-Auth signed CDN link */}
				<Modal
					title="Share file"
					open={!!shareKey}
					onCancel={closeShare}
					footer={[
						<PvButton key="close" onClick={closeShare}>
							Close
						</PvButton>,
					]}
				>
					<div className="vp-stack">
						<div>
							<span className="vp-label">File</span>
							<div className="vp-text vp-files-sharekey">{shareKey}</div>
						</div>
						<div className="vp-field">
							<span className="vp-label">Expires in</span>
							<Select
								value={shareExpiry}
								onChange={setShareExpiry}
								style={{ width: "100%" }}
								options={[
									{ value: 300, label: "5 minutes" },
									{ value: 3600, label: "1 hour" },
									{ value: 86400, label: "1 day" },
									{ value: 604800, label: "7 days" },
								]}
							/>
						</div>
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
							<div className="vp-field">
								<span className="vp-label">Signed URL</span>
								<div className="vp-row vp-files-shareurl">
									<Input value={shareUrl} readOnly />
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
							</div>
						) : null}
					</div>
				</Modal>
			</div>
		</PageContent>
	);
};

export default Files;
