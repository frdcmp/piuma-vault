import { useState } from "react";
import { PvMenu, PvModal, pvMessage } from "@/admin/components/ui";
import {
	useStorageDeleteFolder,
	useStorageDeleteObject,
	useStorageList,
	useStorageSignedUrl,
	useStorageZip,
} from "../../../queries";
import {
	selectSingleFileKey,
	useStorageWorkspace,
} from "../../../store/storageWorkspaceStore";
import FolderShareModal from "./FolderShareModal";

// Folder prefixes from the backend look like "docs/2026/"; show just the leaf.
const folderLeaf = (path) => {
	const trimmed = path.replace(/\/$/, "");
	return trimmed.split("/").pop() || "/";
};

// File keys look like "docs/2026/report.pdf"; show just the file name.
const fileLeaf = (key) => key.split("/").pop() || key;

// A glyph picked from the file extension, mirroring the grid's icons.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const isImage = (key) => IMAGE_RE.test(key);
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

// Mirrors the Notes tree prefix: ancestor trunks + a corner branch char so each
// row visibly hangs off its parent. `parentLines[i]` true → that ancestor still
// has more siblings below it.
const TreePrefix = ({ parentLines, isLast }) => (
	<span className="ftree-prefix">
		{parentLines.map((more, i) => (
			<span
				// Stable per position: the boolean run up to this depth is unique by length.
				key={parentLines.slice(0, i + 1).join("-")}
				className={more ? "ftree-trunk" : "ftree-gap"}
			>
				{more ? "│  " : "   "}
			</span>
		))}
		<span className="ftree-branch">{isLast ? "└─ " : "├─ "}</span>
	</span>
);

/**
 * One folder node. Lazily lists its children via `useStorageList` only while
 * expanded, so the tree fetches on demand exactly like the Notes vault.
 */
const TreeFolder = ({
	path,
	depth,
	parentLines = [],
	isLast = false,
	currentPrefix,
	onNavigate,
	onSelectFile,
	onContext,
	expanded: expandedMap,
	toggleExpand,
}) => {
	// The single selected file (shared with the grid). Subscribing to the derived
	// key means this node only re-renders when that key actually changes.
	const treeSelectedKey = useStorageWorkspace(selectSingleFileKey);
	const isExpanded = depth === 0 || !!expandedMap[path];
	const { data, isLoading } = useStorageList(
		{ prefix: path },
		{ enabled: isExpanded },
	);

	const subfolders = data?.folders || [];
	const files = data?.files || [];
	const childParentLines = depth > 0 ? [...parentLines, !isLast] : parentLines;
	// Single highlight: the current folder lights up only when no file is picked
	// (picking a file highlights the file row instead).
	const isCurrent = currentPrefix === path && !treeSelectedKey;

	return (
		<div>
			{depth > 0 && (
				// biome-ignore lint/a11y/noStaticElementInteractions: terminal-style folder row, matches Notes vault tree
				// biome-ignore lint/a11y/useKeyWithClickEvents: folder also reachable from the breadcrumb
				<div
					className={`ftree-row ftree-folder ${isCurrent ? "selected" : ""}`}
					onClick={() => {
						// Click toggles like a file explorer: an open folder collapses
						// in place; a closed one expands and navigates into it.
						if (isExpanded) {
							toggleExpand(path);
						} else {
							onNavigate(path);
							toggleExpand(path);
						}
					}}
					onContextMenu={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onContext({ type: "folder", key: path }, e.clientX, e.clientY);
					}}
				>
					<TreePrefix parentLines={parentLines} isLast={isLast} />
					{/* biome-ignore lint/a11y/noStaticElementInteractions: expand/collapse toggle inside the row */}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: expand/collapse toggle inside the row */}
					<span
						className="ftree-folder-toggle"
						onClick={(e) => {
							e.stopPropagation();
							toggleExpand(path);
						}}
					>
						{isExpanded ? "[-]" : "[+]"}
					</span>
					<span className="ftree-folder-name">
						{folderLeaf(path)}
						<span className="ftree-folder-slash">/</span>
					</span>
				</div>
			)}
			{isExpanded && (
				<>
					{isLoading && depth > 0 && (
						<div className="ftree-row ftree-meta">
							<TreePrefix parentLines={childParentLines} isLast={true} />
							<output
								className="ftree-dog-spinner"
								aria-label="Loading folders"
							>
								<span className="ftree-dog-face">🐶</span>
							</output>
							<span className="ftree-dog-label">listing…</span>
						</div>
					)}
					{subfolders.map((sub, idx) => (
						<TreeFolder
							key={sub}
							path={sub}
							depth={depth + 1}
							parentLines={childParentLines}
							isLast={files.length === 0 && idx === subfolders.length - 1}
							currentPrefix={currentPrefix}
							onNavigate={onNavigate}
							onSelectFile={onSelectFile}
							onContext={onContext}
							expanded={expandedMap}
							toggleExpand={toggleExpand}
						/>
					))}
					{files.map((file, idx) => (
						// biome-ignore lint/a11y/noStaticElementInteractions: terminal-style file row, matches the folder rows
						// biome-ignore lint/a11y/useKeyWithClickEvents: file also reachable from the main grid
						<div
							key={file.key}
							className={`ftree-row ftree-file ${treeSelectedKey === file.key ? "selected" : ""}`}
							onClick={() => onSelectFile(file.key)}
							onContextMenu={(e) => {
								e.preventDefault();
								e.stopPropagation();
								onContext(
									{ type: "file", key: file.key },
									e.clientX,
									e.clientY,
								);
							}}
						>
							<TreePrefix
								parentLines={childParentLines}
								isLast={idx === files.length - 1}
							/>
							<span className="ftree-file-glyph">{fileGlyph(file.key)}</span>
							<span className="ftree-file-name">{fileLeaf(file.key)}</span>
						</div>
					))}
					{!isLoading &&
						subfolders.length === 0 &&
						files.length === 0 &&
						depth > 0 && (
							<div className="ftree-row ftree-meta">
								<TreePrefix parentLines={childParentLines} isLast={true} />
								<span className="ftree-empty">(empty)</span>
							</div>
						)}
				</>
			)}
		</div>
	);
};

/**
 * Left sidebar: a terminal-style tree of folders and their files. Clicking the
 * root banner or a folder sets the explorer's current prefix; clicking a file
 * navigates to its containing folder so it shows in the main grid.
 */
export default function StorageTree({
	currentPrefix,
	onNavigate,
	onSelectFile,
	expanded,
	toggleExpand,
	onBack,
}) {
	const signed = useStorageSignedUrl();
	const zip = useStorageZip();
	const deleteObject = useStorageDeleteObject();
	const deleteFolder = useStorageDeleteFolder();

	// Right-click menu: { x, y, item } where item is { type, key }, or null.
	const [menu, setMenu] = useState(null);
	const [shareFolder, setShareFolder] = useState(null);
	const [confirm, setConfirm] = useState(null); // { title, body, onConfirm }
	const [preview, setPreview] = useState(null); // { key, url, loading }
	// Signed-link share modal state (mirrors the grid).
	const [shareKey, setShareKey] = useState(null);
	const [shareExpiry, setShareExpiry] = useState(3600);
	const [shareUrl, setShareUrl] = useState("");

	const openContext = (item, x, y) => setMenu({ x, y, item });

	const downloadFile = async (key) => {
		try {
			const { url } = await signed.mutateAsync({ key, expiresInSecs: 300 });
			const a = document.createElement("a");
			a.href = url;
			a.download = fileLeaf(key);
			a.rel = "noopener";
			document.body.appendChild(a);
			a.click();
			a.remove();
		} catch (e) {
			pvMessage.error(`Download failed: ${e.message}`);
		}
	};

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

	const openShare = (key) => {
		setShareKey(key);
		setShareExpiry(3600);
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

	const downloadFolderZip = async (key) => {
		try {
			await zip.mutateAsync({ prefix: key, filename: folderLeaf(key) });
		} catch (e) {
			pvMessage.error(`Folder download failed: ${e.message}`);
		}
	};

	const requestDelete = (item) =>
		setConfirm({
			title: item.type === "file" ? "Delete file" : "Delete folder",
			body:
				item.type === "file" ? item.key : `${item.key} and all its contents`,
			onConfirm: async () => {
				try {
					if (item.type === "file") await deleteObject.mutateAsync(item.key);
					else await deleteFolder.mutateAsync(item.key);
					pvMessage.success("Deleted");
				} catch (e) {
					pvMessage.error(`Delete failed: ${e.message}`);
				}
			},
		});

	const menuItems = () => {
		const item = menu?.item;
		if (!item) return [];
		if (item.type === "file") {
			return [
				...(isImage(item.key)
					? [
							{
								label: "Preview",
								icon: "👁",
								onClick: () => openPreview(item.key),
							},
						]
					: []),
				{ label: "Download", icon: "⬇", onClick: () => downloadFile(item.key) },
				{ label: "Share link", icon: "🔗", onClick: () => openShare(item.key) },
				{ type: "separator" },
				{
					label: "Delete",
					icon: "✕",
					danger: true,
					onClick: () => requestDelete(item),
				},
			];
		}
		return [
			{
				label: "Download as zip",
				icon: "⬇",
				onClick: () => downloadFolderZip(item.key),
			},
			{
				label: "Share folder…",
				icon: "🌐",
				onClick: () => setShareFolder(item.key),
			},
			{ type: "separator" },
			{
				label: "Delete folder",
				icon: "✕",
				danger: true,
				onClick: () => requestDelete(item),
			},
		];
	};

	return (
		<div className="notes-sidebar-container">
			<div className="notes-sidebar-header storage-tree-header">
				<div className="notes-sidebar-header-row">
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<button
							type="button"
							className="pixel-btn notes-sidebar-back"
							onClick={onBack}
							title="Go back"
						>
							◀
						</button>
						<div>
							<h3 className="notes-sidebar-title">Storage</h3>
							<div className="storage-sidebar-sub">bunny · zone pv</div>
						</div>
					</div>
				</div>
			</div>

			<div className="notes-sidebar-tree">
				<div className="ftree-root">
					<div className="ftree-banner">
						<button
							type="button"
							className="storage-crumb ftree-banner-text"
							onClick={() => onNavigate("")}
							style={{
								color: currentPrefix === "" ? "var(--accent)" : undefined,
							}}
						>
							~/storage ▒▒
						</button>
						<span className="ftree-banner-hint">tree</span>
					</div>
					<TreeFolder
						path=""
						depth={0}
						currentPrefix={currentPrefix}
						onNavigate={onNavigate}
						onSelectFile={onSelectFile}
						onContext={openContext}
						expanded={expanded}
						toggleExpand={toggleExpand}
					/>
				</div>
			</div>

			{/* Right-click context menu for tree files & folders */}
			<PvMenu
				open={!!menu}
				x={menu?.x ?? 0}
				y={menu?.y ?? 0}
				items={menu ? menuItems() : []}
				onClose={() => setMenu(null)}
			/>

			{/* Public folder-share dialog */}
			<FolderShareModal
				open={!!shareFolder}
				prefix={shareFolder}
				onClose={() => setShareFolder(null)}
			/>

			{/* Delete confirmation */}
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

			{/* Share modal (signed link with expiry) */}
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
					htmlFor="tree-share-expiry"
					style={{ display: "block", marginBottom: 6, fontSize: 12 }}
				>
					Expires in
				</label>
				<select
					id="tree-share-expiry"
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

			{/* Preview modal (image) */}
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
		</div>
	);
}
