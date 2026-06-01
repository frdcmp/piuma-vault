import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { PvMenu, pvMessage, pvToast } from "@/admin/components/ui";
import {
	getShareMeta,
	listShareFolder,
	shareCreateFolder,
	shareDeleteFolder,
	shareDeleteObject,
	sharePresignUpload,
	shareSignedUrl,
	shareZip,
} from "../api/folderShares";
import "../admin/pages/storage/Storage.css";
import "./SharedFolderPage.css";

const formatBytes = (n) => {
	if (!n) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(n) / Math.log(1024));
	return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

const folderLeaf = (p) => p.replace(/\/$/, "").split("/").pop() || "/";
const fileLeaf = (k) => k.split("/").pop() || k;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const fileGlyph = (key) => {
	const ext = key.split(".").pop()?.toLowerCase();
	if (IMAGE_RE.test(key)) return "🖼";
	if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) return "🗜";
	if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "🎞";
	if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return "🎵";
	if (["pdf"].includes(ext)) return "📕";
	if (["md", "txt", "json", "csv", "log", "yml", "yaml"].includes(ext))
		return "📄";
	return "▦";
};

/**
 * Public, slug-based folder viewer. Browses a shared storage folder recursively
 * and — when the share is `edit` — uploads, deletes, and creates folders. All
 * paths are relative to the share root; the backend enforces containment.
 */
export default function SharedFolderPage() {
	const { slug } = useParams();
	const [meta, setMeta] = useState(null);
	const [needPwd, setNeedPwd] = useState(false);
	const [pwd, setPwd] = useState("");
	const [pwdInput, setPwdInput] = useState("");
	const [fatal, setFatal] = useState(null);

	const [path, setPath] = useState(""); // relative dir, "" = root
	const [listing, setListing] = useState({ folders: [], files: [] });
	const [loading, setLoading] = useState(true);
	const [dragOver, setDragOver] = useState(false);
	const [menu, setMenu] = useState(null); // { x, y, item }
	const [busy, setBusy] = useState(null);
	const fileInputRef = useRef(null);

	const canEdit = meta?.can_edit;

	// Load share metadata once.
	useEffect(() => {
		let alive = true;
		getShareMeta(slug)
			.then((m) => {
				if (!alive) return;
				setMeta(m);
				setNeedPwd(m.requires_password);
			})
			.catch((e) => {
				if (alive) setFatal(e?.response?.data?.error || "Share link not found");
			});
		return () => {
			alive = false;
		};
	}, [slug]);

	const refresh = useCallback(
		async (nextPath = path) => {
			setLoading(true);
			try {
				const res = await listShareFolder(slug, { path: nextPath, pwd });
				setListing({ folders: res.folders || [], files: res.files || [] });
				setNeedPwd(false);
			} catch (e) {
				if (e?.response?.status === 401) setNeedPwd(true);
				else pvMessage.error(e?.response?.data?.error || e.message);
			} finally {
				setLoading(false);
			}
		},
		[slug, pwd, path],
	);

	// Initial + on-navigation listing, once we're past the password gate.
	useEffect(() => {
		if (!meta || (meta.requires_password && !pwd)) return;
		refresh(path);
	}, [meta, pwd, path, refresh]);

	const crumbs = useMemo(() => {
		const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
		return parts.map((name, i) => ({
			name,
			path: `${parts.slice(0, i + 1).join("/")}/`,
		}));
	}, [path]);

	const submitPwd = () => {
		setPwd(pwdInput);
	};

	// ── File actions ──────────────────────────────────────────────
	const openFile = async (relKey) => {
		try {
			const { url } = await shareSignedUrl(slug, { path: relKey, pwd });
			window.open(url, "_blank", "noopener");
		} catch (e) {
			pvMessage.error(e?.response?.data?.error || e.message);
		}
	};

	const downloadFile = async (relKey) => {
		try {
			const { url } = await shareSignedUrl(slug, { path: relKey, pwd });
			const a = document.createElement("a");
			a.href = url;
			a.download = fileLeaf(relKey);
			a.rel = "noopener";
			document.body.appendChild(a);
			a.click();
			a.remove();
		} catch (e) {
			pvMessage.error(e?.response?.data?.error || e.message);
		}
	};

	const downloadFolderZip = async (relDir) => {
		setBusy("Zipping…");
		try {
			const { url } = await shareZip(slug, { path: relDir, pwd });
			const a = document.createElement("a");
			a.href = url;
			a.rel = "noopener";
			document.body.appendChild(a);
			a.click();
			a.remove();
		} catch (e) {
			pvMessage.error(e?.response?.data?.error || e.message);
		} finally {
			setBusy(null);
		}
	};

	const deleteFile = async (relKey) => {
		try {
			await shareDeleteObject(slug, { path: relKey, pwd });
			pvMessage.success("Deleted");
			refresh();
		} catch (e) {
			pvMessage.error(e?.response?.data?.error || e.message);
		}
	};

	const deleteFolder = async (relDir) => {
		try {
			await shareDeleteFolder(slug, { path: relDir, pwd });
			pvMessage.success("Folder deleted");
			refresh();
		} catch (e) {
			pvMessage.error(e?.response?.data?.error || e.message);
		}
	};

	const createFolder = async () => {
		const name = window.prompt("New folder name");
		if (!name) return;
		try {
			await shareCreateFolder(slug, { path: `${path}${name}/`, pwd });
			pvMessage.success("Folder created");
			refresh();
		} catch (e) {
			pvMessage.error(e?.response?.data?.error || e.message);
		}
	};

	const uploadFiles = async (fileList) => {
		const arr = Array.from(fileList || []);
		if (arr.length === 0) return;
		const total = arr.length;
		const toast = pvToast.show({
			label: `Uploading ${arr[0].name}…`,
			progress: null,
		});
		let failed = 0;
		for (let i = 0; i < total; i++) {
			const file = arr[i];
			toast.update({
				label: `Uploading ${file.name}${total > 1 ? ` (${i + 1}/${total})` : ""}…`,
				progress: null,
			});
			try {
				const { url } = await sharePresignUpload(slug, {
					path: `${path}${file.name}`,
					contentType: file.type || "application/octet-stream",
					pwd,
				});
				const res = await fetch(url, {
					method: "PUT",
					body: file,
					headers: { "Content-Type": file.type || "application/octet-stream" },
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
			} catch (e) {
				failed += 1;
				pvMessage.error(`Upload failed: ${file.name} — ${e.message}`);
			}
		}
		if (failed === 0) toast.success(`${total} uploaded`);
		else toast.error(`${total - failed} uploaded, ${failed} failed`);
		refresh();
	};

	const onDrop = (e) => {
		e.preventDefault();
		setDragOver(false);
		if (canEdit && e.dataTransfer?.files?.length)
			uploadFiles(e.dataTransfer.files);
	};

	// ── Render guards ─────────────────────────────────────────────
	if (fatal) {
		return (
			<div className="notes-pixel-layout sfshare-screen">
				<div className="sfshare-card">
					<h2>Link unavailable</h2>
					<p>{fatal}</p>
				</div>
			</div>
		);
	}
	if (!meta) {
		return (
			<div className="notes-pixel-layout sfshare-screen">
				<div className="sfshare-card">loading…</div>
			</div>
		);
	}
	if (needPwd) {
		return (
			<div className="notes-pixel-layout sfshare-screen">
				<div className="sfshare-card">
					<h2>🔒 Password required</h2>
					<input
						className="pixel-input"
						type="password"
						value={pwdInput}
						onChange={(e) => setPwdInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && submitPwd()}
						placeholder="enter password"
					/>
					<button
						type="button"
						className="pixel-btn primary"
						onClick={submitPwd}
					>
						Unlock
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="notes-pixel-layout sfshare-wrap">
			<div className="storage-main sfshare-main">
				{/* Top bar */}
				<div className="storage-topbar">
					<div className="storage-breadcrumb">
						<button
							type="button"
							className={`storage-crumb ${path === "" ? "current" : ""}`}
							onClick={() => setPath("")}
						>
							🌐 {meta.root_name}
						</button>
						{crumbs.map((c, i) => (
							<span key={c.path} style={{ display: "inline-flex" }}>
								<span className="storage-crumb-sep">/</span>
								<button
									type="button"
									className={`storage-crumb ${i === crumbs.length - 1 ? "current" : ""}`}
									onClick={() => setPath(c.path)}
								>
									{c.name}
								</button>
							</span>
						))}
					</div>
					<div className="storage-topbar-actions">
						<span className={`fshare-badge ${meta.access_level}`}>
							{meta.access_level}
						</span>
						{canEdit && (
							<>
								<button
									type="button"
									className="pixel-btn"
									onClick={createFolder}
								>
									+ Folder
								</button>
								<button
									type="button"
									className="pixel-btn primary"
									onClick={() => fileInputRef.current?.click()}
								>
									⬆ Upload
								</button>
								<input
									ref={fileInputRef}
									type="file"
									multiple
									style={{ display: "none" }}
									onChange={(e) => {
										uploadFiles(e.target.files);
										e.target.value = "";
									}}
								/>
							</>
						)}
						<button
							type="button"
							className="pixel-btn"
							onClick={() => downloadFolderZip(path)}
						>
							⬇ Download all
						</button>
					</div>
				</div>

				{/* Body */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for uploads */}
				<div
					className={`storage-body ${dragOver ? "drag-over" : ""}`}
					onDragOver={(e) => {
						if (!canEdit) return;
						e.preventDefault();
						if (!dragOver) setDragOver(true);
					}}
					onDragLeave={(e) => {
						if (e.currentTarget === e.target) setDragOver(false);
					}}
					onDrop={onDrop}
				>
					{loading ? (
						<div className="notes-sidebar-status">loading…</div>
					) : listing.folders.length === 0 && listing.files.length === 0 ? (
						<div className="notes-sidebar-status notes-sidebar-status-empty">
							{canEdit
								? "Empty — drop files here to upload."
								: "This folder is empty."}
						</div>
					) : (
						<>
							{listing.folders.length > 0 && (
								<>
									<div className="storage-section-label">
										<span>Folders ({listing.folders.length})</span>
									</div>
									<div className="storage-grid">
										{listing.folders.map((f) => (
											// biome-ignore lint/a11y/noStaticElementInteractions: tile click enters the folder
											// biome-ignore lint/a11y/useKeyWithClickEvents: actions reachable from tile buttons
											<div
												key={f}
												className="storage-tile folder"
												onClick={() => setPath(f)}
												onContextMenu={(e) => {
													e.preventDefault();
													setMenu({ x: e.clientX, y: e.clientY, dir: f });
												}}
											>
												<div className="storage-tile-top">
													<span className="storage-tile-glyph">📁</span>
													<span className="storage-tile-name">
														{folderLeaf(f)}
													</span>
												</div>
											</div>
										))}
									</div>
								</>
							)}

							{listing.files.length > 0 && (
								<>
									<div className="storage-section-label">
										<span>Files ({listing.files.length})</span>
									</div>
									<div className="storage-grid">
										{listing.files.map((file) => (
											// biome-ignore lint/a11y/noStaticElementInteractions: tile dbl-click opens the file
											<div
												key={file.key}
												className="storage-tile file"
												onDoubleClick={() => openFile(file.key)}
												onContextMenu={(e) => {
													e.preventDefault();
													setMenu({
														x: e.clientX,
														y: e.clientY,
														file: file.key,
													});
												}}
											>
												<div className="storage-tile-top">
													<span className="storage-tile-glyph">
														{fileGlyph(file.key)}
													</span>
													<span className="storage-tile-name">
														{fileLeaf(file.key)}
													</span>
												</div>
												<div className="storage-tile-meta">
													<span className="storage-tile-size">
														{formatBytes(file.size)}
													</span>
												</div>
											</div>
										))}
									</div>
								</>
							)}
						</>
					)}
				</div>

				{/* Context menu */}
				<PvMenu
					open={!!menu}
					x={menu?.x ?? 0}
					y={menu?.y ?? 0}
					items={
						menu?.file
							? [
									{
										label: "Open",
										icon: "👁",
										onClick: () => openFile(menu.file),
									},
									{
										label: "Download",
										icon: "⬇",
										onClick: () => downloadFile(menu.file),
									},
									...(canEdit
										? [
												{ type: "separator" },
												{
													label: "Delete",
													icon: "✕",
													danger: true,
													onClick: () => deleteFile(menu.file),
												},
											]
										: []),
								]
							: menu?.dir
								? [
										{
											label: "Download as zip",
											icon: "⬇",
											onClick: () => downloadFolderZip(menu.dir),
										},
										...(canEdit
											? [
													{ type: "separator" },
													{
														label: "Delete folder",
														icon: "✕",
														danger: true,
														onClick: () => deleteFolder(menu.dir),
													},
												]
											: []),
									]
								: []
					}
					onClose={() => setMenu(null)}
				/>

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
		</div>
	);
}
