import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import WorkspaceShell from "../../../chat/WorkspaceShell";
import { useStorageWorkspace } from "../../../store/storageWorkspaceStore";
import "../notes/NotesSidebar.css";
import "./Storage.css";
import StorageGrid from "./StorageGrid";
import StorageTree from "./StorageTree";

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 300;
const SIDEBAR_STORAGE_KEY = "pv:storage-sidebar-width";

const clampWidth = (n, min, max) => Math.min(max, Math.max(min, Math.round(n)));

const readStoredWidth = () => {
	try {
		const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
		const n = raw == null ? SIDEBAR_DEFAULT : Number.parseInt(raw, 10);
		return clampWidth(
			Number.isFinite(n) ? n : SIDEBAR_DEFAULT,
			SIDEBAR_MIN,
			SIDEBAR_MAX,
		);
	} catch {
		return SIDEBAR_DEFAULT;
	}
};

/**
 * Pixel-art storage explorer: folder tree (left) + folder-contents grid (right),
 * styled like the Notes vault. Current folder prefix is shared between the tree
 * and the grid; the sidebar is resizable and persists its width.
 */
export default function StorageExplorer() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	// The folder path lives in the ?path= query param, so it survives reloads
	// and back/forward. Normalize to a trailing-slash prefix.
	const raw = searchParams.get("path") ?? "";
	const prefix = raw ? `${raw.replace(/\/+$/, "")}/` : "";
	const [expanded, setExpanded] = useState({});
	const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
	const [isResizing, setIsResizing] = useState(false);
	// Selection lives in the shared store so the tree and grid stay in sync.
	const selectOne = useStorageWorkspace((s) => s.selectOne);
	const clearSelection = useStorageWorkspace((s) => s.clearSelection);

	const toggleExpand = useCallback((path) => {
		setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
	}, []);

	// Push a folder onto the URL; the prefix derives from the ?path= query param.
	const pushFolder = useCallback(
		(p) => {
			const clean = p ? p.replace(/\/+$/, "") : "";
			navigate(
				clean ? `/storage?path=${encodeURIComponent(clean)}` : "/storage",
			);
		},
		[navigate],
	);

	// Navigating to a folder clears the selection (fresh folder, fresh selection).
	const handleNavigate = useCallback(
		(p) => {
			clearSelection();
			pushFolder(p);
		},
		[clearSelection, pushFolder],
	);

	// A file clicked in the tree: select it (store → grid + tree both highlight)
	// and navigate to its folder. Selection is NOT cleared, so it survives the nav.
	const handleSelectFile = useCallback(
		(fileKey) => {
			const slash = fileKey.lastIndexOf("/");
			const parent = slash === -1 ? "" : fileKey.slice(0, slash + 1);
			selectOne(fileKey);
			pushFolder(parent);
		},
		[selectOne, pushFolder],
	);

	// Keep all ancestors of the current folder expanded so it stays visible.
	useEffect(() => {
		if (!prefix) return;
		const parts = prefix.replace(/\/$/, "").split("/").filter(Boolean);
		const ancestors = [];
		let cur = "";
		for (const part of parts) {
			cur += `${part}/`;
			ancestors.push(cur);
		}
		setExpanded((prev) => {
			const next = { ...prev };
			for (const a of ancestors) next[a] = true;
			return next;
		});
	}, [prefix]);

	useEffect(() => {
		if (!isResizing) return;
		const onMove = (e) =>
			setSidebarWidth(clampWidth(e.clientX, SIDEBAR_MIN, SIDEBAR_MAX));
		const onUp = () => setIsResizing(false);
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		const prevCursor = document.body.style.cursor;
		const prevSelect = document.body.style.userSelect;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
		};
	}, [isResizing]);

	useEffect(() => {
		try {
			localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
		} catch {
			/* localStorage unavailable */
		}
	}, [sidebarWidth]);

	return (
		<WorkspaceShell>
			<div className="notes-pixel-layout">
				<div className="notes-pixel-sidebar" style={{ width: sidebarWidth }}>
					<StorageTree
						currentPrefix={prefix}
						onNavigate={handleNavigate}
						onSelectFile={handleSelectFile}
						expanded={expanded}
						toggleExpand={toggleExpand}
						onBack={() => navigate(-1)}
					/>
				</div>

				{/* biome-ignore lint/a11y/useSemanticElements: draggable column resizer */}
				<div
					className={`notes-sidebar-resizer ${isResizing ? "active" : ""}`}
					onMouseDown={(e) => {
						e.preventDefault();
						setIsResizing(true);
					}}
					onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
					onKeyDown={(e) => {
						const step = e.shiftKey ? 32 : 8;
						if (e.key === "ArrowLeft")
							setSidebarWidth((w) =>
								clampWidth(w - step, SIDEBAR_MIN, SIDEBAR_MAX),
							);
						else if (e.key === "ArrowRight")
							setSidebarWidth((w) =>
								clampWidth(w + step, SIDEBAR_MIN, SIDEBAR_MAX),
							);
						else return;
						e.preventDefault();
					}}
					role="separator"
					tabIndex={0}
					aria-orientation="vertical"
					aria-label="Resize sidebar"
					aria-valuenow={sidebarWidth}
					aria-valuemin={SIDEBAR_MIN}
					aria-valuemax={SIDEBAR_MAX}
					title="Drag to resize · double-click to reset"
				/>

				<StorageGrid prefix={prefix} onNavigate={handleNavigate} />
			</div>
		</WorkspaceShell>
	);
}
