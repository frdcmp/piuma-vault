import { useMemo, useState } from "react";
import { PvModal, pvMessage, pvToast } from "@/admin/components/ui";
import UserMenu from "../../../components/UserMenu";
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

const formatBytes = (n) => {
	if (!n) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(n) / Math.log(1024));
	return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

const folderLeaf = (path) => {
	const trimmed = path.replace(/\/$/, "");
	return trimmed.split("/").pop() || "/";
};

const fileLeaf = (key) => key.split("/").pop() || key;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const isImage = (key) => IMAGE_RE.test(key);

// A glyph picked from the file extension, purely cosmetic.
const fileGlyph = (key) => {
	const ext = key.split(".").pop()?.toLowerCase();
	if (isImage(key)) return "🖼";
	if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) return "🗜";
	if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "🎞";
	if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return "🎵";
	if (["pdf"].includes(ext)) return "📕";
	if (["md", "txt", "json", "csv", "log", "yml", "yaml"].includes(ext))
		return "📄";
	return "▦";
};

/**
 * Main panel of the storage explorer: breadcrumb, drag-drop upload, and a tile
 * grid of subfolders + files for the current prefix. Owns selection and all the
 * action modals (share / preview / new folder / confirm). Storage mutations
 * invalidate the whole `storage` query key, so the left tree refreshes too.
 */
export default function StorageGrid({ prefix, onNavigate }) {
	const list = useStorageList({ prefix });
	const upload = useStorageUpload();
	const deleteObject = useStorageDeleteObject();
	const deleteFolder = useStorageDeleteFolder();
	const bulkDelete = useStorageBulkDelete();
	const download = useStorageDownload();
	const zip = useStorageZip();
	const signed = useStorageSignedUrl();

	const folders = list.data?.folders || [];
	const files = list.data?.files || [];
	const isEmpty = !list.isLoading && folders.length === 0 && files.length === 0;

	// Label for the blocking overlay — null when nothing blocking is in flight.
	// Uploads are NOT blocking: they show a bottom-right progress toast instead.
	const busy = zip.isPending
		? "Zipping…"
		: download.isPending
			? "Downloading…"
			: deleteFolder.isPending
				? "Deleting folder…"
				: bulkDelete.isPending
					? "Deleting…"
					: deleteObject.isPending
						? "Deleting…"
						: signed.isPending
							? "Preparing link…"
							: null;

	const [selected, setSelected] = useState(() => new Set());
	const [dragOver, setDragOver] = useState(false);
	// Folder key currently being hovered with a drag, so its tile can highlight.
	const [dragFolder, setDragFolder] = useState(null);

	// Modal state.
	const [shareKey, setShareKey] = useState(null);
	const [shareExpiry, setShareExpiry] = useState(3600);
	const [shareUrl, setShareUrl] = useState("");
	const [preview, setPreview] = useState(null); // { key, url, loading }
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [confirm, setConfirm] = useState(null); // { title, body, onConfirm }

	const clearSelection = () => setSelected(new Set());

	const crumbs = useMemo(() => {
		const trimmed = prefix.replace(/\/$/, "");
		if (!trimmed) return [];
		const segments = trimmed.split("/");
		return segments.map((seg, i) => ({
			name: seg,
			path: `${segments.slice(0, i + 1).join("/")}/`,
		}));
	}, [prefix]);

	const navigate = (p) => {
		clearSelection();
		onNavigate(p);
	};

	const toggleOne = (key) =>
		setSelected((prev) => {
			const next = new Set(prev);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});

	const allFilesSelected =
		files.length > 0 && files.every((f) => selected.has(f.key));
	const toggleAll = () =>
		setSelected(
			allFilesSelected ? new Set() : new Set(files.map((f) => f.key)),
		);

	// ── Uploads ──────────────────────────────────────────────────
	// Files are uploaded by dropping them on the body (→ current prefix) or on a
	// folder tile (→ that folder). `target` defaults to the current prefix.
	const uploadFiles = async (fileList, target = prefix) => {
		const arr = Array.from(fileList || []);
		if (arr.length === 0) return;
		const total = arr.length;
		const counter = (i) => (total > 1 ? ` (${i + 1}/${total})` : "");
		const toast = pvToast.show({
			label: `Uploading ${arr[0].name}${counter(0)}…`,
			progress: 0,
		});
		let failed = 0;
		for (let i = 0; i < total; i++) {
			const file = arr[i];
			toast.update({
				label: `Uploading ${file.name}${counter(i)}…`,
				progress: 0,
			});
			try {
				await upload.mutateAsync({
					file,
					path: target,
					onProgress: (frac) => toast.update({ progress: (i + frac) / total }),
				});
			} catch (e) {
				failed += 1;
				pvMessage.error(
					`Upload failed: ${file.name} — ${e?.response?.data?.message || e.message}`,
				);
			}
		}
		const ok = total - failed;
		if (failed === 0) {
			toast.success(
				total > 1 ? `${ok} files uploaded` : `${arr[0].name} uploaded`,
			);
		} else if (ok === 0) {
			toast.error(total > 1 ? `${failed} uploads failed` : "Upload failed");
		} else {
			toast.error(`${ok} uploaded, ${failed} failed`);
		}
	};

	const onDrop = (e) => {
		e.preventDefault();
		setDragOver(false);
		if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
	};

	// Drop onto a folder tile uploads into that folder instead of the current
	// prefix. We stop propagation so the body's drop handler doesn't also fire.
	const onFolderDrop = (e, folderKey) => {
		e.preventDefault();
		e.stopPropagation();
		setDragFolder(null);
		setDragOver(false);
		if (e.dataTransfer?.files?.length)
			uploadFiles(e.dataTransfer.files, folderKey);
	};

	// ── Deletes ──────────────────────────────────────────────────
	const handleDeleteFile = (key) =>
		setConfirm({
			title: "Delete file",
			body: key,
			danger: true,
			onConfirm: async () => {
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
			},
		});

	const handleDeleteFolder = (folderKey) =>
		setConfirm({
			title: "Delete folder and all contents",
			body: folderKey,
			danger: true,
			onConfirm: async () => {
				try {
					await deleteFolder.mutateAsync(folderKey);
					pvMessage.success("Folder deleted");
				} catch (e) {
					pvMessage.error(`Delete failed: ${e.message}`);
				}
			},
		});

	const handleBulkDelete = () => {
		const keys = Array.from(selected);
		if (keys.length === 0) return;
		setConfirm({
			title: `Delete ${keys.length} file${keys.length === 1 ? "" : "s"}`,
			body: keys.join("\n"),
			danger: true,
			onConfirm: async () => {
				try {
					const res = await bulkDelete.mutateAsync(keys);
					pvMessage.success(`Deleted ${res.deleted?.length ?? 0}`);
					if (res.failed?.length)
						pvMessage.warning(`${res.failed.length} failed`);
					clearSelection();
				} catch (e) {
					pvMessage.error(`Bulk delete failed: ${e.message}`);
				}
			},
		});
	};

	// ── Folder download (zipped automatically) ───────────────────
	// Folders can't be downloaded as-is, so we zip them server-side (staged to
	// __temp on Bunny) and pull the archive straight from the CDN. Files download
	// directly via their signed URL — only folders go through zip.
	const downloadFolder = async (folderKey) => {
		try {
			await zip.mutateAsync({
				prefix: folderKey,
				filename: folderLeaf(folderKey),
			});
		} catch (e) {
			pvMessage.error(`Folder download failed: ${e.message}`);
		}
	};

	// ── Share signed link ────────────────────────────────────────
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

	// ── Image preview (uses a short-lived signed CDN URL) ────────
	const openPreview = async (key) => {
		setPreview({ key, loading: true });
		try {
			const res = await signed.mutateAsync({ key, expiresInSecs: 300 });
			setPreview({ key, url: res.url });
		} catch (e) {
			pvMessage.error(`Preview unavailable: ${e.message}`);
			setPreview(null);
		}
	};

	// ── New folder (virtual until a file lands in it) ────────────
	const createFolder = () => {
		const name = newFolderName.trim().replace(/^\/+|\/+$/g, "");
		if (!name) return;
		navigate(`${prefix}${name}/`);
		setNewFolderOpen(false);
		setNewFolderName("");
		pvMessage.info("Upload a file here to save the folder");
	};

	return (
		<div className="storage-main">
			{/* Top bar: breadcrumb + global actions */}
			<div className="storage-topbar">
				<div className="storage-breadcrumb">
					<button
						type="button"
						className={`storage-crumb ${prefix === "" ? "current" : ""}`}
						onClick={() => navigate("")}
					>
						🏠 root
					</button>
					{crumbs.map((c, i) => (
						<span key={c.path} style={{ display: "inline-flex" }}>
							<span className="storage-crumb-sep">/</span>
							<button
								type="button"
								className={`storage-crumb ${
									i === crumbs.length - 1 ? "current" : ""
								}`}
								onClick={() => navigate(c.path)}
							>
								{c.name}
							</button>
						</span>
					))}
				</div>
				<div className="storage-topbar-actions">
					<button
						type="button"
						className="pixel-btn"
						onClick={() => setNewFolderOpen(true)}
					>
						+ Folder
					</button>
					<button
						type="button"
						className="pixel-btn icon-only"
						onClick={() => list.refetch()}
						title="Refresh"
						disabled={list.isFetching}
					>
						<span className={list.isFetching ? "storage-spin" : undefined}>
							⟳
						</span>
					</button>
					<UserMenu size={34} />
				</div>
			</div>

			{/* Scrollable body */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for file uploads */}
			<div
				className={`storage-body ${dragOver ? "drag-over" : ""}`}
				onDragOver={(e) => {
					e.preventDefault();
					if (!dragOver) setDragOver(true);
				}}
				onDragLeave={(e) => {
					if (e.currentTarget === e.target) setDragOver(false);
				}}
				onDrop={onDrop}
			>
				{/* Bulk-selection bar */}
				{selected.size > 0 && (
					<div className="storage-bulkbar">
						<span className="storage-bulkbar-label">
							{selected.size} selected
						</span>
						<div className="storage-bulkbar-actions">
							<button
								type="button"
								className="pixel-btn danger"
								onClick={handleBulkDelete}
								disabled={bulkDelete.isPending}
							>
								✕ Delete
							</button>
							<button
								type="button"
								className="pixel-btn"
								onClick={clearSelection}
							>
								Clear
							</button>
						</div>
					</div>
				)}

				{list.isLoading ? (
					<div className="notes-sidebar-status notes-sidebar-status-loading">
						<output className="ftree-dog-spinner" aria-label="Loading">
							<span className="ftree-dog-face">🐶</span>
						</output>
						<span>listing {prefix || "/"}…</span>
					</div>
				) : isEmpty ? (
					<div className="notes-sidebar-status notes-sidebar-status-empty">
						Nothing in {prefix || "/"} yet — drop files here to upload.
					</div>
				) : (
					<>
						{/* Folders */}
						{folders.length > 0 && (
							<>
								<div className="storage-section-label">
									<span>Folders ({folders.length})</span>
								</div>
								<div className="storage-grid">
									{folders.map((f) => (
										// biome-ignore lint/a11y/noStaticElementInteractions: tile click navigates into the folder
										// biome-ignore lint/a11y/useKeyWithClickEvents: actions are reachable via the tile buttons
										<div
											key={f}
											className={`storage-tile folder ${
												dragFolder === f ? "drag-over" : ""
											}`}
											onClick={() => navigate(f)}
											onDragOver={(e) => {
												e.preventDefault();
												e.stopPropagation();
												if (dragFolder !== f) setDragFolder(f);
											}}
											onDragLeave={(e) => {
												if (e.currentTarget === e.target) setDragFolder(null);
											}}
											onDrop={(e) => onFolderDrop(e, f)}
										>
											<div className="storage-tile-top">
												<span className="storage-tile-glyph">📁</span>
												<span className="storage-tile-name">
													{folderLeaf(f)}
												</span>
											</div>
											<div className="storage-tile-actions">
												<button
													type="button"
													className="storage-act"
													title="Download folder (zipped)"
													onClick={(e) => {
														e.stopPropagation();
														downloadFolder(f);
													}}
												>
													⬇
												</button>
												<button
													type="button"
													className="storage-act danger"
													title="Delete folder"
													onClick={(e) => {
														e.stopPropagation();
														handleDeleteFolder(f);
													}}
												>
													✕
												</button>
											</div>
										</div>
									))}
								</div>
							</>
						)}

						{/* Files */}
						{files.length > 0 && (
							<>
								<div className="storage-section-label">
									<span>Files ({files.length})</span>
									{/* biome-ignore lint/a11y/noStaticElementInteractions: pixel select-all toggle */}
									{/* biome-ignore lint/a11y/useKeyWithClickEvents: cosmetic toggle, files selectable per-tile */}
									<span className="storage-selectall" onClick={toggleAll}>
										<span
											className={`storage-check ${allFilesSelected ? "on" : ""}`}
										>
											{allFilesSelected ? "✓" : ""}
										</span>
										select all
									</span>
								</div>
								<div className="storage-grid">
									{files.map((file) => {
										const sel = selected.has(file.key);
										return (
											// biome-ignore lint/a11y/noStaticElementInteractions: tile click toggles selection
											// biome-ignore lint/a11y/useKeyWithClickEvents: actions are reachable via the tile buttons
											<div
												key={file.key}
												className={`storage-tile file ${sel ? "selected" : ""}`}
												onClick={() => toggleOne(file.key)}
											>
												<div className="storage-tile-top">
													<span
														className={`storage-check ${sel ? "on" : ""}`}
														title="Select"
													>
														{sel ? "✓" : ""}
													</span>
													<span className="storage-tile-name">
														{fileLeaf(file.key)}
													</span>
												</div>
												<div className="storage-tile-meta">
													<span className="storage-tile-size">
														{formatBytes(file.size)}
													</span>
													{file.last_modified && (
														<span>{formatDate(file.last_modified)}</span>
													)}
												</div>
												<div className="storage-tile-actions">
													<span className="storage-tile-glyph">
														{fileGlyph(file.key)}
													</span>
													{isImage(file.key) && (
														<button
															type="button"
															className="storage-act"
															title="Preview"
															onClick={(e) => {
																e.stopPropagation();
																openPreview(file.key);
															}}
														>
															👁
														</button>
													)}
													<button
														type="button"
														className="storage-act"
														title="Download"
														onClick={(e) => {
															e.stopPropagation();
															download.mutate(file.key);
														}}
													>
														⬇
													</button>
													<button
														type="button"
														className="storage-act"
														title="Share"
														onClick={(e) => {
															e.stopPropagation();
															setShareKey(file.key);
															setShareExpiry(3600);
															setShareUrl("");
														}}
													>
														🔗
													</button>
													<button
														type="button"
														className="storage-act danger"
														title="Delete"
														onClick={(e) => {
															e.stopPropagation();
															handleDeleteFile(file.key);
														}}
													>
														✕
													</button>
												</div>
											</div>
										);
									})}
								</div>
							</>
						)}
					</>
				)}
			</div>

			{/* New-folder modal */}
			<PvModal
				open={newFolderOpen}
				title="New folder"
				confirmText="Create"
				onConfirm={createFolder}
				onCancel={() => {
					setNewFolderOpen(false);
					setNewFolderName("");
				}}
			>
				<label
					htmlFor="storage-new-folder"
					style={{ display: "block", marginBottom: 6, fontSize: 12 }}
				>
					Folder name (created under {prefix || "/"})
				</label>
				<input
					id="storage-new-folder"
					className="pixel-input"
					style={{ width: "100%", boxSizing: "border-box" }}
					value={newFolderName}
					onChange={(e) => setNewFolderName(e.target.value)}
					placeholder="my-folder"
				/>
			</PvModal>

			{/* Confirm (delete) modal */}
			<PvModal
				open={!!confirm}
				title={confirm?.title || "Confirm"}
				confirmText="Delete"
				danger
				onConfirm={() => {
					confirm?.onConfirm?.();
					setConfirm(null);
				}}
				onCancel={() => setConfirm(null)}
			>
				<div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
					{confirm?.body}
				</div>
			</PvModal>

			{/* Share modal */}
			<PvModal
				open={!!shareKey}
				title="Share file"
				showClose
				onCancel={() => {
					setShareKey(null);
					setShareUrl("");
				}}
			>
				<div style={{ marginBottom: 10, wordBreak: "break-all" }}>
					<b>{shareKey}</b>
				</div>
				<label
					htmlFor="storage-share-expiry"
					style={{ display: "block", marginBottom: 6, fontSize: 12 }}
				>
					Expires in
				</label>
				<select
					id="storage-share-expiry"
					className="pixel-input"
					style={{ width: "100%", boxSizing: "border-box" }}
					value={shareExpiry}
					onChange={(e) => setShareExpiry(Number(e.target.value))}
				>
					<option value={300}>5 minutes</option>
					<option value={3600}>1 hour</option>
					<option value={86400}>1 day</option>
					<option value={604800}>7 days</option>
				</select>
				<button
					type="button"
					className="pixel-btn primary"
					style={{ marginTop: 12 }}
					onClick={generateShareLink}
					disabled={signed.isPending}
				>
					⤴ Generate share link
				</button>
				{shareUrl && (
					<div className="storage-share-url">
						<input className="pixel-input" value={shareUrl} readOnly />
						<button type="button" className="pixel-btn" onClick={copyShareLink}>
							Copy
						</button>
					</div>
				)}
			</PvModal>

			{/* Preview modal */}
			<PvModal
				open={!!preview}
				title={preview ? fileLeaf(preview.key) : "Preview"}
				showClose
				onCancel={() => setPreview(null)}
			>
				{preview?.loading ? (
					<div className="notes-sidebar-status">loading preview…</div>
				) : preview?.url ? (
					<img
						className="storage-preview-img"
						src={preview.url}
						alt={fileLeaf(preview.key)}
					/>
				) : null}
			</PvModal>

			{/* Blocking loading overlay for any in-flight blocking operation */}
			{busy && (
				<div className="storage-busy-overlay">
					<div className="storage-busy-card">
						<output className="ftree-dog-spinner" aria-label="Working">
							<span className="ftree-dog-face">🐶</span>
						</output>
						<span>{busy}</span>
					</div>
				</div>
			)}
		</div>
	);
}
