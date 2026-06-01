import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	FlatList,
	Linking,
	Modal,
	PanResponder,
	Platform,
	Pressable,
	ScrollView,
	Share,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import BottomSheet, { BottomSheetItem } from "../components/BottomSheet";
import FolderShareSheet from "../components/FolderShareSheet";
import { BottomBar, useTopInset } from "../components/SystemBars";
import {
	useStorageBulkDelete,
	useStorageDeleteFolder,
	useStorageDeleteObject,
	useStorageList,
	useStorageSignedUrl,
	useStorageUpload,
	useStorageZip,
} from "../queries/storageQuery";
import { colors } from "../utils/theme";

// expo-document-picker is a native module; require it lazily so the screen still
// bundles/runs in an older build. Upload prompts to rebuild if it's missing.
let DocumentPicker = null;
try {
	DocumentPicker = require("expo-document-picker");
} catch {
	DocumentPicker = null;
}

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "monospace",
});

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

// Vector icon per file type — coloured + sized via props, so it stays crisp and
// legible instead of relying on the platform's (often dim, monochrome) emoji.
const fileIcon = (key) => {
	const ext = key.split(".").pop()?.toLowerCase();
	if (IMAGE_RE.test(key)) return "image-outline";
	if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) return "archive-outline";
	if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "film-outline";
	if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext))
		return "musical-notes-outline";
	if (ext === "pdf") return "document-text-outline";
	if (["md", "txt", "json", "csv", "log", "yml", "yaml"].includes(ext))
		return "document-outline";
	return "document-outline";
};

const fmtDate = (iso) => {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, {
		day: "2-digit",
		month: "short",
		year: "numeric",
	});
};

export default function StorageScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const topInset = useTopInset();
	const [prefix, setPrefix] = useState("");
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	// Action menu for a tapped row, and the item pending delete confirmation.
	// Uses Modals (not Alert) so it works on web/react-native-web too.
	const [sheet, setSheet] = useState(null);
	const [pendingDelete, setPendingDelete] = useState(null);
	// Folder key whose public-share sheet is open, or null.
	const [shareFolder, setShareFolder] = useState(null);
	// Non-null while a blocking op (download/upload) is in flight — drives the
	// loading overlay. Holds the label to show.
	const [busy, setBusy] = useState(null);
	// Multi-select: long-press a row to enter. `selected` holds keys — folder
	// keys end in "/", file keys don't, so one Set covers both (like the web).
	const [selectMode, setSelectMode] = useState(false);
	const [selected, setSelected] = useState(() => new Set());

	const list = useStorageList({ prefix });
	const upload = useStorageUpload();
	const deleteObject = useStorageDeleteObject();
	const deleteFolder = useStorageDeleteFolder();
	const bulkDelete = useStorageBulkDelete();
	const signed = useStorageSignedUrl();
	const zip = useStorageZip();

	const folders = list.data?.folders || [];
	const files = list.data?.files || [];
	const isEmpty = !list.isLoading && folders.length === 0 && files.length === 0;

	// Back: step up one folder level; only leave the screen at the root. Shared
	// by the header arrow and the left-edge swipe gesture.
	const handleBack = useCallback(() => {
		if (prefix === "") {
			navigation.goBack();
		} else {
			const parts = prefix.replace(/\/$/, "").split("/");
			parts.pop();
			setPrefix(parts.length ? `${parts.join("/")}/` : "");
		}
	}, [prefix, navigation]);

	// A right-swipe from the left edge goes back, mirroring the arrow. PanResponder
	// (built-in, no native module) is created once, so route through a ref to keep
	// `handleBack` fresh. It only claims left-edge, horizontal, rightward drags, so
	// vertical list scrolling and the breadcrumb strip are left untouched.
	const handleBackRef = useRef(handleBack);
	handleBackRef.current = handleBack;
	const edgeSwipe = useRef(
		PanResponder.create({
			onMoveShouldSetPanResponder: (_e, g) =>
				g.x0 <= 36 && g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.8,
			onPanResponderRelease: (_e, g) => {
				if (g.dx > 64 && g.vx > 0.05) handleBackRef.current?.();
			},
		}),
	).current;

	const crumbs = useMemo(() => {
		const trimmed = prefix.replace(/\/$/, "");
		if (!trimmed) return [];
		const segments = trimmed.split("/");
		return segments.map((seg, i) => ({
			name: seg,
			path: `${segments.slice(0, i + 1).join("/")}/`,
		}));
	}, [prefix]);

	const rows = useMemo(
		() => [
			...folders.map((f) => ({ type: "folder", id: `d:${f}`, key: f })),
			...files.map((f) => ({ type: "file", id: `f:${f.key}`, ...f })),
		],
		[folders, files],
	);

	// Leaving a folder drops any selection from it (and exits select mode).
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on folder change
	useEffect(() => {
		setSelectMode(false);
		setSelected(new Set());
	}, [prefix]);

	// ── Actions ──────────────────────────────────────────────────
	// Download = open a short-lived signed CDN URL in the browser, which saves
	// the file (no extra native modules needed).
	const downloadFile = async (key) => {
		setBusy("Preparing download…");
		try {
			const res = await signed.mutateAsync({ key, expiresInSecs: 3600 });
			const ok = await Linking.canOpenURL(res.url);
			if (ok) Linking.openURL(res.url);
			else Alert.alert("Cannot open", "No app available to open this link.");
		} catch (e) {
			Alert.alert(
				"Download unavailable",
				e?.response?.data?.message || e.message || "Could not sign a link.",
			);
		} finally {
			setBusy(null);
		}
	};

	// Folders can't be downloaded directly — zip them server-side (staged to
	// __temp on Bunny) and open the signed CDN URL.
	const downloadFolder = async (folderKey) => {
		setBusy("Zipping folder…");
		try {
			const { url } = await zip.mutateAsync({
				prefix: folderKey,
				filename: folderLeaf(folderKey),
			});
			const ok = await Linking.canOpenURL(url);
			if (ok) Linking.openURL(url);
			else Alert.alert("Cannot open", "No app available to open this link.");
		} catch (e) {
			Alert.alert(
				"Download failed",
				e?.response?.data?.message || e.message || "Could not zip the folder.",
			);
		} finally {
			setBusy(null);
		}
	};

	// ── Multi-select ─────────────────────────────────────────────
	const enterSelect = (key) => {
		setSelectMode(true);
		setSelected(new Set([key]));
	};
	const toggleSelect = (key) =>
		setSelected((prev) => {
			const next = new Set(prev);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});
	const exitSelect = () => {
		setSelectMode(false);
		setSelected(new Set());
	};
	const selectAll = () => setSelected(new Set(rows.map((r) => r.key)));

	// Download the selection: a lone file opens directly; anything else is zipped
	// (files as keys, folders expanded server-side via prefixes).
	const downloadSelection = async () => {
		const keys = Array.from(selected);
		if (keys.length === 0) return;
		const folderKeys = keys.filter((k) => k.endsWith("/"));
		const fileKeys = keys.filter((k) => !k.endsWith("/"));
		if (keys.length === 1 && fileKeys.length === 1) {
			downloadFile(fileKeys[0]);
			return;
		}
		if (keys.length === 1 && folderKeys.length === 1) {
			downloadFolder(folderKeys[0]);
			return;
		}
		setBusy("Zipping…");
		try {
			const { url } = await zip.mutateAsync({
				keys: fileKeys,
				prefixes: folderKeys,
				filename: "selection",
			});
			const ok = await Linking.canOpenURL(url);
			if (ok) Linking.openURL(url);
			else Alert.alert("Cannot open", "No app available to open this link.");
		} catch (e) {
			Alert.alert(
				"Download failed",
				e?.response?.data?.message ||
					e.message ||
					"Could not zip the selection.",
			);
		} finally {
			setBusy(null);
		}
	};

	// Delete the whole selection (files via bulk endpoint, folders recursively).
	const deleteSelection = async () => {
		const keys = Array.from(selected);
		setPendingDelete(null);
		if (keys.length === 0) return;
		const folderKeys = keys.filter((k) => k.endsWith("/"));
		const fileKeys = keys.filter((k) => !k.endsWith("/"));
		setBusy("Deleting…");
		try {
			if (fileKeys.length) await bulkDelete.mutateAsync(fileKeys);
			for (const f of folderKeys) await deleteFolder.mutateAsync(f);
			exitSelect();
		} catch (e) {
			Alert.alert(
				"Delete failed",
				e?.response?.data?.message || e.message || "Unknown error",
			);
		} finally {
			setBusy(null);
		}
	};

	const openSheet = (item) => setSheet(item);
	const closeSheet = () => setSheet(null);

	// Primary action from the menu: open/share a file, or enter a folder.
	// The sheet dismisses itself after the press.
	const sheetPrimary = () => {
		if (!sheet) return;
		if (sheet.type === "file") downloadFile(sheet.key);
		else setPrefix(sheet.key);
	};

	// Stash a follow-up action; it runs via the sheet's onClosed once the sheet
	// has finished closing (RN can't show two modals — or a modal + the OS share
	// sheet — at once).
	const pendingActionRef = useRef(null);
	const requestDelete = () => {
		pendingActionRef.current = { kind: "delete", item: sheet };
	};
	const requestShareFile = () => {
		pendingActionRef.current = { kind: "shareFile", key: sheet?.key };
	};
	const requestShareFolder = () => {
		pendingActionRef.current = { kind: "shareFolder", key: sheet?.key };
	};
	const handleSheetClosed = () => {
		const action = pendingActionRef.current;
		pendingActionRef.current = null;
		if (!action) return;
		if (action.kind === "delete") setPendingDelete(action.item);
		else if (action.kind === "shareFile") shareFile(action.key);
		else if (action.kind === "shareFolder") setShareFolder(action.key);
	};

	// Share a single file: mint a short-lived signed CDN URL and hand it to the
	// OS share sheet so it can be copied or sent anywhere.
	const shareFile = async (key) => {
		setBusy("Preparing link…");
		try {
			const res = await signed.mutateAsync({ key, expiresInSecs: 3600 });
			await Share.share({ message: res.url });
		} catch (e) {
			if (e?.message !== "User did not share")
				Alert.alert(
					"Share unavailable",
					e?.response?.data?.message || e.message || "Could not sign a link.",
				);
		} finally {
			setBusy(null);
		}
	};

	const confirmDelete = async () => {
		const item = pendingDelete;
		setPendingDelete(null);
		if (!item) return;
		setBusy(item.type === "file" ? "Deleting…" : "Deleting folder…");
		try {
			if (item.type === "file") await deleteObject.mutateAsync(item.key);
			else await deleteFolder.mutateAsync(item.key);
		} catch (e) {
			Alert.alert(
				"Delete failed",
				e?.response?.data?.message || e.message || "Unknown error",
			);
		} finally {
			setBusy(null);
		}
	};

	// New folders are virtual until a file lands in them — Bunny/S3 has no empty
	// folders. Navigate into the new prefix and let the upload create it (same
	// behaviour as the web explorer).
	const createFolder = () => {
		const name = newFolderName.trim().replace(/^\/+|\/+$/g, "");
		setNewFolderOpen(false);
		setNewFolderName("");
		if (!name) return;
		setPrefix(`${prefix}${name}/`);
		Alert.alert("Folder ready", "Upload a file here to save the folder.");
	};

	const pickAndUpload = async () => {
		if (!DocumentPicker) {
			Alert.alert(
				"Rebuild required",
				"Uploading needs the expo-document-picker native module. Rebuild the app to enable it.",
			);
			return;
		}
		try {
			const res = await DocumentPicker.getDocumentAsync({
				copyToCacheDirectory: true,
				multiple: false,
			});
			if (res.canceled) return;
			const asset = res.assets?.[0];
			if (!asset) return;
			setBusy("Uploading…");
			await upload.mutateAsync({
				file: {
					uri: asset.uri,
					name: asset.name,
					mimeType: asset.mimeType,
				},
				path: prefix,
			});
		} catch (e) {
			Alert.alert(
				"Upload failed",
				e?.response?.data?.message || e.message || "Unknown error",
			);
		} finally {
			setBusy(null);
		}
	};

	// A small pixel checkbox shown on the left of each row in select mode.
	const Checkbox = ({ on }) => (
		<View style={[styles.checkbox, on && styles.checkboxOn]}>
			{on ? (
				<Ionicons name="checkmark" size={14} color={colors.accent2} />
			) : null}
		</View>
	);

	const renderRow = ({ item }) => {
		const isSel = selected.has(item.key);
		// In select mode a tap toggles; otherwise folder=enter, file=sheet. A
		// long-press always enters select mode with this row selected.
		const onPress = () => {
			if (selectMode) toggleSelect(item.key);
			else if (item.type === "folder") setPrefix(item.key);
			else openSheet(item);
		};
		const onLongPress = () => {
			if (!selectMode) enterSelect(item.key);
		};

		if (item.type === "folder") {
			return (
				<Pressable
					style={({ pressed }) => [
						styles.row,
						pressed && styles.rowPressed,
						isSel && styles.rowSelected,
					]}
					onPress={onPress}
					onLongPress={onLongPress}
					delayLongPress={300}
				>
					{selectMode ? <Checkbox on={isSel} /> : null}
					<Text style={styles.glyph}>📁</Text>
					<Text style={styles.folderName} numberOfLines={1}>
						{folderLeaf(item.key)}
						<Text style={styles.slash}>/</Text>
					</Text>
					{!selectMode ? (
						<Pressable
							style={styles.dotsBtn}
							hitSlop={12}
							onPress={() => openSheet(item)}
						>
							<Ionicons
								name="ellipsis-vertical"
								size={18}
								color={colors.muted}
							/>
						</Pressable>
					) : null}
				</Pressable>
			);
		}
		return (
			<Pressable
				style={({ pressed }) => [
					styles.row,
					pressed && styles.rowPressed,
					isSel && styles.rowSelected,
				]}
				onPress={onPress}
				onLongPress={onLongPress}
				delayLongPress={300}
			>
				{selectMode ? <Checkbox on={isSel} /> : null}
				<Ionicons
					name={fileIcon(item.key)}
					size={24}
					color={colors.accent4}
					style={styles.fileIcon}
				/>
				<View style={styles.fileBody}>
					<Text style={styles.fileName} numberOfLines={1}>
						{fileLeaf(item.key)}
					</Text>
					<Text style={styles.fileMeta} numberOfLines={1}>
						<Text style={styles.fileSize}>{formatBytes(item.size)}</Text>
						{item.last_modified ? `  ·  ${fmtDate(item.last_modified)}` : ""}
					</Text>
				</View>
				{!selectMode ? (
					<Pressable
						style={styles.dotsBtn}
						hitSlop={12}
						onPress={() => openSheet(item)}
					>
						<Ionicons name="ellipsis-vertical" size={18} color={colors.muted} />
					</Pressable>
				) : null}
			</Pressable>
		);
	};

	return (
		<View
			style={[styles.root, { paddingTop: topInset }]}
			{...edgeSwipe.panHandlers}
		>
			{/* Header — swaps to a selection action bar while in select mode. */}
			{selectMode ? (
				<View style={styles.header}>
					<TouchableOpacity
						onPress={exitSelect}
						style={styles.headerBtn}
						hitSlop={10}
					>
						<Ionicons name="close" size={22} color={colors.text} />
					</TouchableOpacity>
					<Text style={[styles.title, { flex: 1 }]}>
						{selected.size} selected
					</Text>
					<TouchableOpacity
						onPress={selectAll}
						style={styles.headerBtn}
						hitSlop={10}
					>
						<Ionicons
							name="checkmark-done-outline"
							size={22}
							color={colors.text}
						/>
					</TouchableOpacity>
					<TouchableOpacity
						onPress={downloadSelection}
						style={styles.headerBtn}
						hitSlop={10}
						disabled={selected.size === 0}
					>
						<Ionicons
							name="download-outline"
							size={22}
							color={colors.accent2}
						/>
					</TouchableOpacity>
					<TouchableOpacity
						onPress={() =>
							selected.size > 0 && setPendingDelete({ bulk: true })
						}
						style={styles.headerBtn}
						hitSlop={10}
						disabled={selected.size === 0}
					>
						<Ionicons name="trash-outline" size={22} color={colors.accent3} />
					</TouchableOpacity>
				</View>
			) : (
				<View style={styles.header}>
					<TouchableOpacity
						onPress={handleBack}
						style={styles.headerBtn}
						hitSlop={10}
					>
						<Ionicons name="arrow-back" size={22} color={colors.text} />
					</TouchableOpacity>
					<View style={{ flex: 1 }}>
						<Text style={styles.title}>Storage</Text>
						<Text style={styles.subtitle}>bunny · zone pv</Text>
					</View>
					{/* Manual refresh — also reachable when a folder is empty (no
					    FlatList pull-to-refresh there). Bunny's listing is eventually
					    consistent, so a re-fetch after a write may be needed. */}
					<TouchableOpacity
						onPress={() => list.refetch()}
						style={styles.headerBtn}
						hitSlop={10}
						disabled={list.isFetching}
					>
						{list.isFetching ? (
							<ActivityIndicator size="small" color={colors.muted} />
						) : (
							<Ionicons name="refresh" size={20} color={colors.text} />
						)}
					</TouchableOpacity>
					<TouchableOpacity
						onPress={() => setNewFolderOpen(true)}
						style={styles.folderBtn}
						hitSlop={10}
					>
						<Ionicons name="folder-outline" size={16} color={colors.accent} />
						<Text style={styles.folderBtnPlus}>+</Text>
					</TouchableOpacity>
					<TouchableOpacity
						onPress={pickAndUpload}
						style={styles.uploadBtn}
						hitSlop={10}
						disabled={upload.isPending}
					>
						{upload.isPending ? (
							<ActivityIndicator size="small" color={colors.accent2} />
						) : (
							<>
								<Ionicons
									name="cloud-upload-outline"
									size={16}
									color={colors.accent2}
								/>
								<Text style={styles.uploadText}>UPLOAD</Text>
							</>
						)}
					</TouchableOpacity>
				</View>
			)}

			{/* Breadcrumb */}
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				style={styles.crumbBar}
				contentContainerStyle={styles.crumbContent}
			>
				<Pressable onPress={() => setPrefix("")}>
					<Text style={[styles.crumb, prefix === "" && styles.crumbCurrent]}>
						🏠 root
					</Text>
				</Pressable>
				{crumbs.map((c, i) => (
					<View key={c.path} style={styles.crumbItem}>
						<Text style={styles.crumbSep}>/</Text>
						<Pressable onPress={() => setPrefix(c.path)}>
							<Text
								style={[
									styles.crumb,
									i === crumbs.length - 1 && styles.crumbCurrent,
								]}
							>
								{c.name}
							</Text>
						</Pressable>
					</View>
				))}
			</ScrollView>

			{/* Body */}
			{list.isLoading ? (
				<View style={styles.center}>
					<ActivityIndicator color={colors.accent2} />
					<Text style={styles.dim}>listing {prefix || "/"}…</Text>
				</View>
			) : isEmpty ? (
				<View style={styles.center}>
					<Text style={styles.dim}>Nothing in {prefix || "/"} yet.</Text>
					<Text style={styles.dimSmall}>
						Tap UPLOAD to add a file, or 📁+ to make a folder.
					</Text>
				</View>
			) : (
				<FlatList
					data={rows}
					keyExtractor={(item) => item.id}
					renderItem={renderRow}
					contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
					refreshing={list.isFetching}
					onRefresh={() => list.refetch()}
				/>
			)}

			{/* New-folder modal */}
			<Modal
				visible={newFolderOpen}
				transparent
				animationType="fade"
				onRequestClose={() => setNewFolderOpen(false)}
			>
				<Pressable
					style={styles.modalOverlay}
					onPress={() => setNewFolderOpen(false)}
				>
					<Pressable style={styles.modalCard} onPress={() => {}}>
						<Text style={styles.modalTitle}>New folder</Text>
						<Text style={styles.modalHint}>Created under {prefix || "/"}</Text>
						<TextInput
							style={styles.modalInput}
							value={newFolderName}
							onChangeText={setNewFolderName}
							placeholder="my-folder"
							placeholderTextColor={colors.muted}
							autoFocus
							autoCapitalize="none"
							autoCorrect={false}
							onSubmitEditing={createFolder}
						/>
						<View style={styles.modalActions}>
							<TouchableOpacity
								style={styles.modalBtn}
								onPress={() => {
									setNewFolderOpen(false);
									setNewFolderName("");
								}}
							>
								<Text style={styles.modalBtnText}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								style={[styles.modalBtn, styles.modalBtnPrimary]}
								onPress={createFolder}
							>
								<Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>
									Create
								</Text>
							</TouchableOpacity>
						</View>
					</Pressable>
				</Pressable>
				<BottomBar />
			</Modal>

			{/* Per-item action menu (swipe down or tap backdrop to close) */}
			<BottomSheet
				visible={!!sheet}
				onClose={closeSheet}
				onClosed={handleSheetClosed}
				title={
					sheet
						? sheet.type === "file"
							? fileLeaf(sheet.key)
							: `${folderLeaf(sheet.key)}/`
						: ""
				}
				subtitle={sheet?.type === "file" ? formatBytes(sheet.size) : undefined}
			>
				<BottomSheetItem
					icon={sheet?.type === "file" ? "download-outline" : "enter-outline"}
					label={sheet?.type === "file" ? "Download" : "Open folder"}
					color={colors.accent2}
					onPress={sheetPrimary}
				/>
				{sheet?.type === "folder" && (
					<BottomSheetItem
						icon="archive-outline"
						label="Download (zip)"
						color={colors.accent2}
						onPress={() => sheet && downloadFolder(sheet.key)}
					/>
				)}
				{sheet?.type === "file" && (
					<BottomSheetItem
						icon="share-outline"
						label="Share link"
						color={colors.accent4}
						onPress={requestShareFile}
					/>
				)}
				{sheet?.type === "folder" && (
					<BottomSheetItem
						icon="globe-outline"
						label="Share folder…"
						color={colors.accent4}
						onPress={requestShareFolder}
					/>
				)}
				<BottomSheetItem
					icon="trash-outline"
					label="Delete"
					color={colors.accent3}
					onPress={requestDelete}
				/>
			</BottomSheet>

			{/* Public folder-share manager */}
			<FolderShareSheet
				visible={!!shareFolder}
				prefix={shareFolder}
				onClose={() => setShareFolder(null)}
			/>

			{/* Delete confirmation */}
			<Modal
				visible={!!pendingDelete}
				transparent
				animationType="fade"
				onRequestClose={() => setPendingDelete(null)}
			>
				<Pressable
					style={styles.modalOverlay}
					onPress={() => setPendingDelete(null)}
				>
					<Pressable style={styles.modalCard} onPress={() => {}}>
						<Text style={styles.modalTitle}>
							{pendingDelete?.bulk
								? `Delete ${selected.size} item${selected.size === 1 ? "" : "s"}?`
								: pendingDelete?.type === "file"
									? "Delete file?"
									: "Delete folder?"}
						</Text>
						<Text style={styles.modalHint} numberOfLines={3}>
							{pendingDelete?.bulk
								? "The selected files and folders will be permanently deleted."
								: pendingDelete?.type === "file"
									? pendingDelete?.key
									: `${pendingDelete?.key || ""} and all its contents`}
						</Text>
						<View style={styles.modalActions}>
							<TouchableOpacity
								style={styles.modalBtn}
								onPress={() => setPendingDelete(null)}
							>
								<Text style={styles.modalBtnText}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								style={[styles.modalBtn, styles.modalBtnDanger]}
								onPress={pendingDelete?.bulk ? deleteSelection : confirmDelete}
							>
								<Text style={[styles.modalBtnText, styles.modalBtnTextDanger]}>
									Delete
								</Text>
							</TouchableOpacity>
						</View>
					</Pressable>
				</Pressable>
				<BottomBar />
			</Modal>

			{/* Blocking loading overlay for downloads / uploads */}
			<Modal visible={!!busy} transparent animationType="fade">
				<View style={styles.busyOverlay}>
					<View style={styles.busyCard}>
						<ActivityIndicator color={colors.accent2} />
						<Text style={styles.busyText}>{busy}</Text>
					</View>
				</View>
				<BottomBar />
			</Modal>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	header: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 12,
		paddingVertical: 10,
		backgroundColor: colors.panel,
		borderBottomWidth: 2,
		borderBottomColor: colors.borderStrong,
		borderStyle: "dashed",
	},
	headerBtn: { padding: 4 },
	folderBtn: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 8,
		paddingVertical: 7,
		borderWidth: 2,
		borderColor: colors.accent,
		backgroundColor: colors.bgSoft,
	},
	folderBtnPlus: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 13,
		fontWeight: "700",
		marginLeft: 2,
	},
	title: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 18,
		fontWeight: "700",
		letterSpacing: 0.5,
	},
	subtitle: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 10,
		marginTop: 1,
	},
	uploadBtn: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 10,
		paddingVertical: 7,
		borderWidth: 2,
		borderColor: colors.accent2,
		backgroundColor: colors.bgSoft,
	},
	uploadText: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
	},
	crumbBar: {
		flexGrow: 0,
		backgroundColor: colors.panel,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	crumbContent: {
		alignItems: "center",
		paddingHorizontal: 12,
		paddingVertical: 8,
	},
	crumbItem: { flexDirection: "row", alignItems: "center" },
	crumb: {
		color: colors.accent4,
		fontFamily: MONO,
		fontSize: 13,
		paddingHorizontal: 4,
	},
	crumbCurrent: { color: colors.accent, fontWeight: "700" },
	crumbSep: { color: colors.muted, fontFamily: MONO, fontSize: 13 },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 14,
		paddingVertical: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	rowPressed: { backgroundColor: colors.bgSoft },
	rowSelected: { backgroundColor: "rgba(92, 208, 169, 0.10)" },
	checkbox: {
		width: 18,
		height: 18,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bg,
		alignItems: "center",
		justifyContent: "center",
		marginRight: 2,
	},
	checkboxOn: { borderColor: colors.accent2 },
	glyph: { fontSize: 20, width: 26, textAlign: "center" },
	fileIcon: { width: 28, textAlign: "center" },
	dotsBtn: {
		paddingHorizontal: 6,
		paddingVertical: 4,
		marginLeft: 4,
	},
	folderName: {
		flex: 1,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
	},
	slash: { color: colors.accent2 },
	fileBody: { flex: 1, minWidth: 0 },
	fileName: {
		color: colors.accent4,
		fontFamily: MONO,
		fontSize: 14,
	},
	fileMeta: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		marginTop: 2,
	},
	fileSize: { color: colors.accent2 },
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
	},
	dim: { color: colors.muted, fontFamily: MONO, fontSize: 14 },
	dimSmall: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		opacity: 0.8,
		textAlign: "center",
		paddingHorizontal: 24,
	},
	modalOverlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 28,
	},
	modalCard: {
		width: "100%",
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		padding: 18,
	},
	modalTitle: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 16,
		fontWeight: "700",
	},
	modalHint: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		marginTop: 4,
		marginBottom: 12,
	},
	modalInput: {
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bg,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		paddingHorizontal: 10,
		paddingVertical: 8,
	},
	modalActions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		gap: 8,
		marginTop: 16,
	},
	modalBtn: {
		paddingHorizontal: 14,
		paddingVertical: 8,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	modalBtnPrimary: { borderColor: colors.accent2 },
	modalBtnDanger: { borderColor: colors.accent3 },
	modalBtnText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
	},
	modalBtnTextPrimary: { color: colors.accent2 },
	modalBtnTextDanger: { color: colors.accent3 },
	busyOverlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
	},
	busyCard: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 20,
		paddingVertical: 16,
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
	},
	busyText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 13,
		fontWeight: "700",
	},
});
