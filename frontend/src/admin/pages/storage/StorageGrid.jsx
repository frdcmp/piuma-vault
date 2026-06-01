import { useEffect, useMemo, useRef, useState } from "react";
import {
	PvMenu,
	PvModal,
	pvMessage,
	pvToast,
} from "@/admin/components/ui";
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
import { useStorageWorkspace } from "../../../store/storageWorkspaceStore";
import { formatDate } from "../../../utils/dateTime";
import FolderShareModal from "./FolderShareModal";

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

	// Selection is shared with the tree via the workspace store. It holds both
	// folder keys (trailing "/") and file keys — they never collide.
	const selected = useStorageWorkspace((s) => s.selection);
	const setSelection = useStorageWorkspace((s) => s.setSelection);
	const selectOne = useStorageWorkspace((s) => s.selectOne);
	const toggleOne = useStorageWorkspace((s) => s.toggle);
	const clearSelection = useStorageWorkspace((s) => s.clearSelection);
	const [dragOver, setDragOver] = useState(false);
	// Folder key currently being hovered with a drag, so its tile can highlight.
	const [dragFolder, setDragFolder] = useState(null);
	// Marquee (rubber-band) rectangle in viewport coords while dragging on empty
	// space; null when not marquee-selecting.
	const [marquee, setMarquee] = useState(null);
	const bodyRef = useRef(null);
	// Hidden file picker for the "Upload files…" menu action.
	const fileInputRef = useRef(null);
	// Right-click context menu anchor: { x, y, bg? } in viewport coords, or null.
	// `bg: true` means it was opened on empty space (the new/upload menu).
	const [menu, setMenu] = useState(null);
	// Folder key whose public-share dialog is open, or null.
	const [shareFolder, setShareFolder] = useState(null);

	// Modal state.
	const [shareKey, setShareKey] = useState(null);
	const [shareExpiry, setShareExpiry] = useState(3600);
	const [shareUrl, setShareUrl] = useState("");
	const [preview, setPreview] = useState(null); // { key, url, loading }
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [newFileOpen, setNewFileOpen] = useState(false);
	const [newFileName, setNewFileName] = useState("");
	const [confirm, setConfirm] = useState(null); // { title, body, onConfirm }

	// When exactly one file is selected (e.g. picked from the tree), scroll it
	// into view once the folder's contents have rendered. No-op if already visible.
	// `files` is a trigger so this re-runs after the listing loads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: files triggers re-scroll on load
	useEffect(() => {
		if (selected.size !== 1) return;
		const [key] = selected;
		if (key.endsWith("/")) return;
		bodyRef.current
			?.querySelector(`[data-sel-key="${CSS.escape(key)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selected, files]);

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

	// A tile was clicked. Ctrl/⌘-click toggles it into the selection (multi);
	// a plain click selects just that one item.
	const onTileClick = (key, e) =>
		e.ctrlKey || e.metaKey ? toggleOne(key) : selectOne(key);

	// Right-clicking a tile that isn't already part of the selection selects just
	// it first (like a file explorer), then opens the context menu at the cursor.
	const onTileContextMenu = (key, e) => {
		e.preventDefault();
		e.stopPropagation();
		if (!selected.has(key)) selectOne(key);
		setMenu({ x: e.clientX, y: e.clientY });
	};

	// ── Marquee (rubber-band) selection ──────────────────────────
	// Drag on empty body space to sweep a rectangle; every folder/file tile it
	// touches gets selected. A plain click on empty space clears the selection.
	const rectsIntersect = (a, b) =>
		a.left < b.right &&
		a.right > b.left &&
		a.top < b.bottom &&
		a.bottom > b.top;

	const applyMarquee = (rect) => {
		const root = bodyRef.current;
		if (!root) return;
		const hit = [];
		for (const el of root.querySelectorAll("[data-sel-key]")) {
			if (rectsIntersect(rect, el.getBoundingClientRect()))
				hit.push(el.dataset.selKey);
		}
		setSelection(hit);
	};

	const onBodyMouseDown = (e) => {
		// Only a left-press on genuinely empty space starts a marquee. Clicks that
		// land on a tile or a control are left to their own handlers.
		if (e.button !== 0) return;
		if (e.target.closest(".storage-tile, button, input, select, a")) return;
		e.preventDefault();
		const startX = e.clientX;
		const startY = e.clientY;
		let moved = false;

		const onMove = (ev) => {
			if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5)
				return;
			moved = true;
			const rect = {
				left: Math.min(startX, ev.clientX),
				top: Math.min(startY, ev.clientY),
				right: Math.max(startX, ev.clientX),
				bottom: Math.max(startY, ev.clientY),
			};
			setMarquee(rect);
			applyMarquee(rect);
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			setMarquee(null);
			// A click with no drag clears the selection, like an empty-space click.
			if (!moved) clearSelection();
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

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
	// All deletion (single or many, files and/or folders) goes through the
	// context menu and this one handler, operating on the current selection.
	const handleBulkDelete = () => {
		const keys = Array.from(selected);
		if (keys.length === 0) return;
		// Folder keys carry a trailing slash and need the recursive folder delete;
		// everything else is a plain object.
		const folderKeys = keys.filter((k) => k.endsWith("/"));
		const fileKeys = keys.filter((k) => !k.endsWith("/"));
		setConfirm({
			title: `Delete ${keys.length} item${keys.length === 1 ? "" : "s"}`,
			body: keys.join("\n"),
			danger: true,
			onConfirm: async () => {
				try {
					let deleted = 0;
					let failed = 0;
					if (fileKeys.length) {
						const res = await bulkDelete.mutateAsync(fileKeys);
						deleted += res.deleted?.length ?? 0;
						failed += res.failed?.length ?? 0;
					}
					for (const folderKey of folderKeys) {
						try {
							await deleteFolder.mutateAsync(folderKey);
							deleted += 1;
						} catch {
							failed += 1;
						}
					}
					pvMessage.success(`Deleted ${deleted}`);
					if (failed) pvMessage.warning(`${failed} failed`);
					clearSelection();
				} catch (e) {
					pvMessage.error(`Bulk delete failed: ${e.message}`);
				}
			},
		});
	};

	// The Delete key deletes the current selection (folders + files), so multi
	// selection stays useful without an on-screen bulk bar. A ref keeps the
	// listener pointed at the latest closure without re-subscribing each render.
	const bulkDeleteRef = useRef(handleBulkDelete);
	bulkDeleteRef.current = handleBulkDelete;
	useEffect(() => {
		const onKey = (e) => {
			if (e.key !== "Delete") return;
			const t = e.target;
			if (
				t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable)
			)
				return;
			bulkDeleteRef.current?.();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

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

	// Download the current selection. A lone file streams directly; a lone folder
	// or any multi-selection is bundled into a single zip server-side.
	const downloadSelection = async () => {
		const keys = Array.from(selected);
		if (keys.length === 0) return;
		const folderKeys = keys.filter((k) => k.endsWith("/"));
		const fileKeys = keys.filter((k) => !k.endsWith("/"));
		if (keys.length === 1 && fileKeys.length === 1) {
			download.mutate(fileKeys[0]);
			return;
		}
		if (keys.length === 1 && folderKeys.length === 1) {
			downloadFolder(folderKeys[0]);
			return;
		}
		try {
			await zip.mutateAsync({
				keys: fileKeys,
				prefixes: folderKeys,
				filename: "selection",
			});
		} catch (e) {
			pvMessage.error(`Download failed: ${e.message}`);
		}
	};

	const openShare = (key) => {
		setShareKey(key);
		setShareExpiry(3600);
		setShareUrl("");
	};

	// Context-menu rows for the current selection: download (zips when it's a
	// folder or a multi-selection), share (single file only), delete.
	const buildMenuItems = () => {
		const keys = Array.from(selected);
		const count = keys.length;
		const single = count === 1;
		const singleFile = single && !keys[0].endsWith("/");
		const singleFolder = single && keys[0].endsWith("/");
		const zips = count > 1 || singleFolder;
		return [
			...(singleFile && isImage(keys[0])
				? [{ label: "Preview", icon: "👁", onClick: () => openPreview(keys[0]) }]
				: []),
			{
				label: zips ? "Download as zip" : "Download",
				icon: "⬇",
				onClick: downloadSelection,
			},
			...(singleFile
				? [
						{
							label: "Share link",
							icon: "🔗",
							onClick: () => openShare(keys[0]),
						},
					]
				: []),
			...(singleFolder
				? [
						{
							label: "Share folder…",
							icon: "🌐",
							onClick: () => setShareFolder(keys[0]),
						},
					]
				: []),
			{ type: "separator" },
			{
				label: count > 1 ? `Delete ${count} items` : "Delete",
				icon: "✕",
				danger: true,
				onClick: handleBulkDelete,
			},
		];
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

	// Double-clicking a file previews it: images open in the in-app modal,
	// everything else opens in a new browser tab via a short-lived signed URL.
	const previewFile = async (key) => {
		if (isImage(key)) {
			openPreview(key);
			return;
		}
		try {
			const res = await signed.mutateAsync({ key, expiresInSecs: 300 });
			window.open(res.url, "_blank", "noopener");
		} catch (e) {
			pvMessage.error(`Preview unavailable: ${e.message}`);
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

	// Create an empty file in the current folder. A 0-byte object carries a real
	// (non-blank) ETag, so it lists as a file — not mistaken for a folder marker.
	const createFile = async () => {
		const name = newFileName.trim().replace(/^\/+|\/+$/g, "");
		setNewFileOpen(false);
		setNewFileName("");
		if (!name || name.endsWith("/")) return;
		await uploadFiles([new File([""], name, { type: "text/plain" })]);
	};

	// ── Empty-space (background) context menu ────────────────────
	const openFilePicker = () => fileInputRef.current?.click();

	const selectAll = () =>
		setSelection([...folders, ...files.map((f) => f.key)]);

	const buildBgMenuItems = () => [
		{ label: "Upload files…", icon: "⬆", onClick: openFilePicker },
		{ label: "New folder…", icon: "📁", onClick: () => setNewFolderOpen(true) },
		{ label: "New file…", icon: "📄", onClick: () => setNewFileOpen(true) },
		...(folders.length + files.length > 0
			? [
					{ type: "separator" },
					{ label: "Select all", icon: "✓", onClick: selectAll },
				]
			: []),
		{ type: "separator" },
		{
			label: "Refresh",
			icon: "⟳",
			onClick: () => list.refetch(),
		},
	];

	// Right-click on empty grid space opens the background menu. Tile right-clicks
	// stopPropagation, so this only fires on the empty area.
	const onBgContextMenu = (e) => {
		e.preventDefault();
		setMenu({ x: e.clientX, y: e.clientY, bg: true });
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
					<UserMenu size={34} />
				</div>
			</div>

			{/* Scrollable body */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for file uploads + marquee selection surface */}
			<div
				ref={bodyRef}
				className={`storage-body ${dragOver ? "drag-over" : ""} ${
					marquee ? "marqueeing" : ""
				}`}
				onMouseDown={onBodyMouseDown}
				onContextMenu={onBgContextMenu}
				onDragOver={(e) => {
					e.preventDefault();
					if (!dragOver) setDragOver(true);
				}}
				onDragLeave={(e) => {
					if (e.currentTarget === e.target) setDragOver(false);
				}}
				onDrop={onDrop}
			>
				{marquee && (
					<div
						className="storage-marquee"
						style={{
							position: "fixed",
							left: marquee.left,
							top: marquee.top,
							width: marquee.right - marquee.left,
							height: marquee.bottom - marquee.top,
						}}
					/>
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
									{folders.map((f) => {
										const sel = selected.has(f);
										return (
											// biome-ignore lint/a11y/noStaticElementInteractions: single click selects, double click enters
											// biome-ignore lint/a11y/useKeyWithClickEvents: actions are reachable via the tile buttons
											<div
												key={f}
												data-sel-key={f}
												className={`storage-tile folder ${sel ? "selected" : ""} ${
													dragFolder === f ? "drag-over" : ""
												}`}
												onClick={(e) => onTileClick(f, e)}
												onDoubleClick={() => navigate(f)}
												onContextMenu={(e) => onTileContextMenu(f, e)}
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
											</div>
										);
									})}
								</div>
							</>
						)}

						{/* Files */}
						{files.length > 0 && (
							<>
								<div className="storage-section-label">
									<span>Files ({files.length})</span>
								</div>
								<div className="storage-grid">
									{files.map((file) => {
										const sel = selected.has(file.key);
										return (
											// biome-ignore lint/a11y/noStaticElementInteractions: single click selects, double click previews
											// biome-ignore lint/a11y/useKeyWithClickEvents: actions are reachable from the context menu
											<div
												key={file.key}
												data-sel-key={file.key}
												className={`storage-tile file ${sel ? "selected" : ""}`}
												onClick={(e) => onTileClick(file.key, e)}
												onDoubleClick={() => previewFile(file.key)}
												onContextMenu={(e) => onTileContextMenu(file.key, e)}
											>
												<div className="storage-tile-top">
													<span className="storage-tile-name">
														{fileLeaf(file.key)}
													</span>
												</div>
												<div className="storage-tile-meta">
													<span className="storage-tile-glyph">
														{fileGlyph(file.key)}
													</span>
													<span className="storage-tile-size">
														{formatBytes(file.size)}
													</span>
													{file.last_modified && (
														<span>{formatDate(file.last_modified)}</span>
													)}
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

			{/* Right-click context menu for the current selection */}
			<PvMenu
				open={!!menu}
				x={menu?.x ?? 0}
				y={menu?.y ?? 0}
				items={menu ? (menu.bg ? buildBgMenuItems() : buildMenuItems()) : []}
				onClose={() => setMenu(null)}
			/>

			{/* Public folder-share dialog */}
			<FolderShareModal
				open={!!shareFolder}
				prefix={shareFolder}
				onClose={() => setShareFolder(null)}
			/>

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

			{/* New-file modal */}
			<PvModal
				open={newFileOpen}
				title="New file"
				confirmText="Create"
				onConfirm={createFile}
				onCancel={() => {
					setNewFileOpen(false);
					setNewFileName("");
				}}
			>
				<label
					htmlFor="storage-new-file"
					style={{ display: "block", marginBottom: 6, fontSize: 12 }}
				>
					File name (created under {prefix || "/"})
				</label>
				<input
					id="storage-new-file"
					className="pixel-input"
					style={{ width: "100%", boxSizing: "border-box" }}
					value={newFileName}
					onChange={(e) => setNewFileName(e.target.value)}
					placeholder="notes.txt"
				/>
			</PvModal>

			{/* Hidden picker for the "Upload files…" menu action */}
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
