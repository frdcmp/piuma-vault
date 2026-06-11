import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import WorkspaceShell from "../../../chat/WorkspaceShell";
import { useStorageWorkspace } from "../../../store/storageWorkspaceStore";
import { PvButton } from "../../components/ui";
import "../tasks/Tasks.css";
import "../notes/NotesSidebar.css";
import "./Storage.css";
import StorageGrid from "./StorageGrid";
import StorageTree from "./StorageTree";

/**
 * Pixel-art storage explorer. Wears the same chrome as the Tasks page — a header
 * (home · glyph · title · actions), a framed folder-tree sidebar, and a framed
 * contents panel — while keeping its file-browser internals (URL-driven folder
 * prefix shared by the tree + grid, internal scroll, drag-drop upload). The
 * header's actions live in StorageGrid and are reached via the shared store.
 */
export default function StorageExplorer() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	// The folder path lives in the ?path= query param, so it survives reloads
	// and back/forward. Normalize to a trailing-slash prefix.
	const raw = searchParams.get("path") ?? "";
	const prefix = raw ? `${raw.replace(/\/+$/, "")}/` : "";
	const [expanded, setExpanded] = useState({});
	// Selection lives in the shared store so the tree and grid stay in sync.
	const selectOne = useStorageWorkspace((s) => s.selectOne);
	const clearSelection = useStorageWorkspace((s) => s.clearSelection);
	// New-folder + upload triggers registered by the grid (null until it mounts).
	const actions = useStorageWorkspace((s) => s.actions);

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

	return (
		<WorkspaceShell>
			<div className="tasks-page storage-page">
				<header className="tasks-header">
					<div className="tasks-title">
						<PvButton variant="ghost" onClick={() => navigate("/notes")}>
							‹ home
						</PvButton>
						<span className="tasks-glyph" aria-hidden="true">
							▦
						</span>
						<h1>Storage</h1>
					</div>
					<div className="tasks-actions">
						<PvButton
							variant="ghost"
							onClick={() => actions?.newFolder?.()}
						>
							+ folder
						</PvButton>
						<PvButton variant="accent" onClick={() => actions?.upload?.()}>
							+ upload
						</PvButton>
					</div>
				</header>

				<div className="tasks-body storage-cols">
					<aside className="tasks-sidebar storage-tree-sidebar">
						<div className="tasks-sidebar-head">
							<h2 className="tasks-panel-title">Files</h2>
							<button
								type="button"
								className="tasks-manage-btn"
								onClick={() => navigate(-1)}
							>
								◀ back
							</button>
						</div>
						<div className="storage-tree-scroll">
							<StorageTree
								embedded
								currentPrefix={prefix}
								onNavigate={handleNavigate}
								onSelectFile={handleSelectFile}
								expanded={expanded}
								toggleExpand={toggleExpand}
								onBack={() => navigate(-1)}
							/>
						</div>
					</aside>

					<section className="tasks-panel storage-panel">
						<StorageGrid prefix={prefix} onNavigate={handleNavigate} />
					</section>
				</div>
			</div>
		</WorkspaceShell>
	);
}
