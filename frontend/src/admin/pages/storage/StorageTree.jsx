import { useStorageList } from "../../../queries";

// Folder prefixes from the backend look like "docs/2026/"; show just the leaf.
const folderLeaf = (path) => {
	const trimmed = path.replace(/\/$/, "");
	return trimmed.split("/").pop() || "/";
};

// File keys look like "docs/2026/report.pdf"; show just the file name.
const fileLeaf = (key) => key.split("/").pop() || key;

// A glyph picked from the file extension, mirroring the grid's icons.
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
	expanded: expandedMap,
	toggleExpand,
}) => {
	const isExpanded = depth === 0 || !!expandedMap[path];
	const { data, isLoading } = useStorageList(
		{ prefix: path },
		{ enabled: isExpanded },
	);

	const subfolders = data?.folders || [];
	const files = data?.files || [];
	const childParentLines = depth > 0 ? [...parentLines, !isLast] : parentLines;
	const isCurrent = currentPrefix === path;

	return (
		<div>
			{depth > 0 && (
				// biome-ignore lint/a11y/noStaticElementInteractions: terminal-style folder row, matches Notes vault tree
				// biome-ignore lint/a11y/useKeyWithClickEvents: folder also reachable from the breadcrumb
				<div
					className={`ftree-row ftree-folder ${isCurrent ? "selected" : ""}`}
					onClick={() => {
						onNavigate(path);
						if (!expandedMap[path]) toggleExpand(path);
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
							<span
								className="ftree-dog-spinner"
								role="status"
								aria-label="Loading folders"
							>
								<span className="ftree-dog-face">🐶</span>
							</span>
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
							expanded={expandedMap}
							toggleExpand={toggleExpand}
						/>
					))}
					{files.map((file, idx) => (
						// biome-ignore lint/a11y/noStaticElementInteractions: terminal-style file row, matches the folder rows
						// biome-ignore lint/a11y/useKeyWithClickEvents: file also reachable from the main grid
						<div
							key={file.key}
							className="ftree-row ftree-file"
							onClick={() => onSelectFile(file.key)}
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
	return (
		<div className="notes-sidebar-container">
			<div className="notes-sidebar-header">
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
						expanded={expanded}
						toggleExpand={toggleExpand}
					/>
				</div>
			</div>
		</div>
	);
}
