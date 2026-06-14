import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Platform,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { useBuckets, useTagRegistry } from "../../queries/tagsQuery";
import {
	useCreateTask,
	useDeleteTask,
	useToggleTask,
	useUpdateTask,
} from "../../queries/tasksQuery";
import { tagColor } from "../../utils/tagColor";
import { colors } from "../../utils/theme";
import AlertsField, { formatOffset } from "../AlertsField";
import BottomSheet from "../BottomSheet";
import ConfirmModal from "../ConfirmModal";
import DateTimePickerField from "../DateTimePickerField";
import TagPicker from "../TagPicker";
import { PRIORITY, PRIORITY_COLOR } from "./taskConstants";
import { s } from "./taskStyles";

// ── Task detail sheet ────────────────────────────────────────────────────────
// TickTick-style: one continuous detail view — completion checkbox + title up
// top, the due date as the headline attribute, then a list of attribute rows
// (priority / list / tags / reminder) that each expand their editor inline as
// an accordion. Only one editor opens at a time, so the sheet never nests more
// than DateTimePickerField's own modal (RN can't stack three deep — see
// BottomSheet.js). Doubles as the create sheet when `task` is null.

/**
 * One TickTick-style attribute row: icon + label on the left, the current value
 * + chevron on the right. Tapping opens its editor sheet.
 */
function AttrRow({ icon, label, value, onPress, disabled, divider = true }) {
	return (
		<Pressable
			style={[
				s.attr,
				!divider && s.attrFlush,
				s.attrHead,
				disabled && s.btnDisabled,
			]}
			onPress={onPress}
			disabled={disabled}
		>
			<Ionicons name={icon} size={16} color={colors.accent2} />
			<Text style={s.attrLabel}>{label}</Text>
			<View style={s.attrValWrap}>{value}</View>
			<Ionicons name="chevron-forward" size={15} color={colors.muted} />
		</Pressable>
	);
}

export function TaskSheet({
	task,
	defaultTags = [],
	defaultBucket = null,
	newRank = null,
	onClose,
}) {
	const editing = !!task;
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const deleteTask = useDeleteTask();
	const toggleTask = useToggleTask();
	const { data: buckets = [] } = useBuckets();
	const { data: tagRegistry = [] } = useTagRegistry();
	const tagColorOf = (name) =>
		tagRegistry.find((r) => r.name === name)?.color || tagColor(name);
	const [title, setTitle] = useState(task?.title ?? "");
	const [notes, setNotes] = useState(task?.notes ?? "");
	const [dueAt, setDueAt] = useState(task?.due_at ?? null);
	const [priority, setPriority] = useState(task?.priority ?? 0);
	const [bucketId, setBucketId] = useState(
		task?.bucket_id ?? defaultBucket ?? null,
	);
	const [tags, setTags] = useState(task?.tags ?? defaultTags);
	const [alerts, setAlerts] = useState(task?.alerts ?? []);
	// Tags and Reminder each open their own nested sheet (like the bucket
	// picker), rather than expanding inline.
	const [tagsOpen, setTagsOpen] = useState(false);
	const [alertsOpen, setAlertsOpen] = useState(false);
	// Bucket lives in the header as a tappable tag; switching it opens a nested
	// picker sheet (TickTick's list selector).
	const [bucketPicker, setBucketPicker] = useState(false);
	// Priority is a flag in the header row; tapping it opens a small popover.
	const [prioMenu, setPrioMenu] = useState(false);
	// Delete confirmation (themed pv dialog, not the native Alert).
	const [confirmDelete, setConfirmDelete] = useState(false);
	// On web, react-native-web renders a multiline TextInput as a fixed-height
	// <textarea> that scrolls instead of growing; we size it from scrollHeight.
	const titleRef = useRef(null);
	const notesRef = useRef(null);

	const done = !!task?.done;

	// ── Debounced optimistic autosave ──────────────────────────────────────────
	// No Save button: edits persist on their own a beat after the user stops
	// typing, and flush immediately when the sheet closes. A new task is created
	// on its first meaningful edit, then switches to in-place updates.
	const idRef = useRef(task?.id ?? null); // null until a new task is created
	const creatingRef = useRef(false); // a create is in flight
	const pendingRef = useRef(false); // edits arrived mid-create → re-commit after
	const seededRef = useRef(false); // first effect run = initial state seeding
	const editedRef = useRef(false); // user has actually changed something
	const skipFlushRef = useRef(false); // suppress the on-close flush (e.g. delete)

	// `mutate` is referentially stable across renders; capture it so `commit`
	// only changes identity when the field values do (that drives the debounce).
	const createMutate = createTask.mutate;
	const updateMutate = updateTask.mutate;
	const commit = useCallback(() => {
		const t = title.trim();
		if (!t) return; // never persist a titleless task
		const payload = {
			title: t,
			notes: notes.trim() || null,
			due_at: dueAt || null,
			priority,
			bucket_id: bucketId || null,
			tags,
			alerts,
		};
		if (idRef.current) {
			updateMutate({ id: idRef.current, ...payload });
		} else if (creatingRef.current) {
			pendingRef.current = true; // wait for the id, then flush the latest
		} else {
			creatingRef.current = true;
			createMutate(
				{ ...payload, rank: newRank },
				{
					onSuccess: (created) => {
						creatingRef.current = false;
						idRef.current = created?.id ?? null;
						if (pendingRef.current) {
							pendingRef.current = false;
							commitRef.current();
						}
					},
					onError: () => {
						creatingRef.current = false;
					},
				},
			);
		}
	}, [
		title,
		notes,
		dueAt,
		priority,
		bucketId,
		tags,
		alerts,
		newRank,
		createMutate,
		updateMutate,
	]);
	// Latest-closure ref for the unmount flush and the post-create re-commit.
	const commitRef = useRef(commit);
	commitRef.current = commit;

	// Debounce: each field change re-arms the timer; firing persists the latest.
	useEffect(() => {
		if (!seededRef.current) {
			// Skip the initial mount — state is just being seeded from `task`.
			seededRef.current = true;
			return;
		}
		editedRef.current = true;
		const h = setTimeout(commit, 1500);
		return () => clearTimeout(h);
	}, [commit]);

	// Flush any pending edit when the sheet closes so the last keystrokes aren't
	// lost inside the debounce window.
	useEffect(() => {
		return () => {
			if (editedRef.current && !skipFlushRef.current) commitRef.current();
		};
	}, []);

	// Web only: grow the title/notes textareas to fit their content (native
	// multiline grows on its own). Reset to auto first so they can also shrink.
	// biome-ignore lint/correctness/useExhaustiveDependencies: title/notes are the re-measure triggers; the nodes are read via refs
	useEffect(() => {
		if (Platform.OS !== "web") return;
		for (const el of [titleRef.current, notesRef.current]) {
			if (el && typeof el.scrollHeight === "number") {
				el.style.height = "auto";
				el.style.height = `${el.scrollHeight}px`;
			}
		}
	}, [title, notes]);

	// Tapping the checkbox completes/reopens the task and closes (same as the
	// list rows). Only meaningful once the task exists.
	const toggleDone = () => {
		if (!idRef.current) return;
		toggleTask.mutate(idRef.current, { onSuccess: onClose });
	};

	const remove = () => {
		if (!idRef.current) return onClose(); // never-saved new task → just close
		setConfirmDelete(true);
	};
	const doDelete = () => {
		skipFlushRef.current = true; // don't resurrect it on unmount
		deleteTask.mutate(idRef.current, { onSuccess: onClose });
	};

	const deleting = deleteTask.isPending;
	const toggling = toggleTask.isPending;

	const bucket = buckets.find((b) => b.id === bucketId);
	const reminderValue = alerts.length
		? [...alerts]
				.sort((a, b) => a.offset_minutes - b.offset_minutes)
				.map((a) => formatOffset(a.offset_minutes))
				.join(", ")
		: dueAt
			? "None"
			: "Set a date";

	return (
		<BottomSheet visible onClose={onClose}>
			<ScrollView
				style={s.sheetScroll}
				contentContainerStyle={s.form}
				keyboardShouldPersistTaps="handled"
				showsVerticalScrollIndicator={false}
			>
				{/* Header: completion checkbox + bucket tag (left), priority flag (right). */}
				<View style={s.headerRow}>
					<View style={s.headerLeft}>
						{editing ? (
							<Pressable onPress={toggleDone} disabled={toggling} hitSlop={8}>
								{toggling ? (
									<ActivityIndicator
										size="small"
										color={PRIORITY_COLOR[priority]}
										style={s.headerCheckSpin}
									/>
								) : (
									<Text
										style={[s.headerCheck, { color: PRIORITY_COLOR[priority] }]}
									>
										{done ? "☑" : "☐"}
									</Text>
								)}
							</Pressable>
						) : null}
						<Pressable
							style={s.bucketChip}
							onPress={() => setBucketPicker(true)}
							hitSlop={6}
						>
							<View
								style={[
									s.bucketSwatch,
									bucket
										? {
												backgroundColor: bucket.color,
												borderColor: bucket.color,
											}
										: null,
								]}
							/>
							<Text style={s.bucketChipText} numberOfLines={1}>
								{bucket?.name ?? "No bucket"}
							</Text>
							<Ionicons name="chevron-down" size={13} color={colors.muted} />
						</Pressable>
					</View>
					<View style={s.headerActions}>
						<Pressable
							style={s.flagBtn}
							onPress={() => setPrioMenu((v) => !v)}
							hitSlop={8}
						>
							<Ionicons
								name={priority ? "flag" : "flag-outline"}
								size={20}
								color={PRIORITY_COLOR[priority]}
							/>
						</Pressable>
						{editing ? (
							<Pressable
								style={s.flagBtn}
								onPress={remove}
								disabled={deleting}
								hitSlop={8}
							>
								{deleting ? (
									<ActivityIndicator size="small" color={colors.accent3} />
								) : (
									<Ionicons
										name="trash-outline"
										size={20}
										color={colors.accent3}
									/>
								)}
							</Pressable>
						) : null}
					</View>
				</View>

				<TextInput
					ref={titleRef}
					style={[s.titleInput, done && s.titleDone]}
					value={title}
					onChangeText={setTitle}
					placeholder="What needs doing?"
					placeholderTextColor={colors.muted}
					multiline
					scrollEnabled={false}
					textAlignVertical="top"
				/>

				{/* Notes — plain description under the title, like TickTick. */}
				<TextInput
					ref={notesRef}
					style={s.notesInput}
					value={notes}
					onChangeText={setNotes}
					placeholder="Add notes…"
					placeholderTextColor={colors.muted}
					multiline
					scrollEnabled={false}
					textAlignVertical="top"
				/>

				{/* Date — the headline attribute, always visible. */}
				<Text style={s.label}>Date</Text>
				<DateTimePickerField
					value={dueAt}
					onChange={(v) => {
						setDueAt(v);
						// Alerts are anchored to the due date — drop them if it's cleared.
						if (!v) {
							setAlerts([]);
							setAlertsOpen(false);
						}
					}}
					mode="datetime"
					placeholder="No date"
				/>

				<AttrRow
					icon="pricetag-outline"
					label="Tags"
					divider={false}
					onPress={() => setTagsOpen(true)}
					value={
						tags.length ? (
							<Text style={s.attrVal} numberOfLines={1}>
								{tags.map((t, i) => (
									<Text key={t} style={{ color: tagColorOf(t) }}>
										{i > 0 ? "  " : ""}#{t}
									</Text>
								))}
							</Text>
						) : (
							<Text style={s.attrVal}>None</Text>
						)
					}
				/>

				<AttrRow
					icon="notifications-outline"
					label="Reminder"
					disabled={!dueAt}
					onPress={() => dueAt && setAlertsOpen(true)}
					value={
						<Text style={s.attrVal} numberOfLines={1}>
							{reminderValue}
						</Text>
					}
				/>
			</ScrollView>

			{/* Priority popover, anchored to the header flag (top-right). Backdrop
			    catches outside taps; listed high → none like TickTick. */}
			{prioMenu ? (
				<View style={s.overlay}>
					<Pressable
						style={s.menuBackdrop}
						onPress={() => setPrioMenu(false)}
					/>
					<View style={s.prioMenu}>
						{[3, 2, 1, 0].map((i) => (
							<Pressable
								key={i}
								style={s.prioMenuItem}
								onPress={() => {
									setPriority(i);
									setPrioMenu(false);
								}}
							>
								<Ionicons
									name={i ? "flag" : "flag-outline"}
									size={15}
									color={PRIORITY_COLOR[i]}
								/>
								<Text
									style={[s.prioMenuText, priority === i && s.prioMenuTextOn]}
								>
									{PRIORITY[i]}
								</Text>
								{priority === i ? (
									<Ionicons name="checkmark" size={14} color={colors.accent2} />
								) : null}
							</Pressable>
						))}
					</View>
				</View>
			) : null}

			{/* Nested bucket picker (one modal deep over this sheet, like the date
			    picker — see BottomSheet.js on RN's nesting limit). */}
			<BucketPickerSheet
				visible={bucketPicker}
				buckets={buckets}
				value={bucketId}
				onSelect={setBucketId}
				onClose={() => setBucketPicker(false)}
			/>

			<BottomSheet
				visible={tagsOpen}
				onClose={() => setTagsOpen(false)}
				title="Tags"
			>
				<ScrollView
					style={s.sheetScroll}
					contentContainerStyle={s.form}
					keyboardShouldPersistTaps="handled"
				>
					<TagPicker value={tags} onChange={setTags} />
					<Pressable style={s.saveBtn} onPress={() => setTagsOpen(false)}>
						<Text style={s.saveBtnText}>Done</Text>
					</Pressable>
				</ScrollView>
			</BottomSheet>

			<BottomSheet
				visible={alertsOpen}
				onClose={() => setAlertsOpen(false)}
				title="Reminder"
			>
				<ScrollView
					style={s.sheetScroll}
					contentContainerStyle={s.form}
					keyboardShouldPersistTaps="handled"
				>
					<AlertsField value={alerts} onChange={setAlerts} />
					<Pressable style={s.saveBtn} onPress={() => setAlertsOpen(false)}>
						<Text style={s.saveBtnText}>Done</Text>
					</Pressable>
				</ScrollView>
			</BottomSheet>

			<ConfirmModal
				visible={confirmDelete}
				title="Delete task"
				message="This can't be undone."
				confirmText="Delete"
				loading={deleting}
				onConfirm={doDelete}
				onCancel={() => setConfirmDelete(false)}
			/>
		</BottomSheet>
	);
}

/** Bottom sheet listing every bucket (plus "No bucket") to move a task into. */
function BucketPickerSheet({ visible, buckets, value, onSelect, onClose }) {
	const pick = (id) => {
		onSelect(id);
		onClose();
	};
	return (
		<BottomSheet
			visible={visible}
			onClose={onClose}
			title="Move to bucket"
			dividerless
		>
			<ScrollView style={s.sheetScroll} contentContainerStyle={s.form}>
				<Pressable
					style={[s.bucketOpt, s.bucketOptFirst]}
					onPress={() => pick(null)}
				>
					<View style={s.bucketSwatch} />
					<Text style={s.bucketOptText}>No bucket</Text>
					{!value ? (
						<Ionicons name="checkmark" size={16} color={colors.accent2} />
					) : null}
				</Pressable>
				{buckets.map((b) => (
					<Pressable key={b.id} style={s.bucketOpt} onPress={() => pick(b.id)}>
						<View
							style={[
								s.bucketSwatch,
								{ backgroundColor: b.color, borderColor: b.color },
							]}
						/>
						<Text style={s.bucketOptText}>{b.name}</Text>
						{value === b.id ? (
							<Ionicons name="checkmark" size={16} color={colors.accent2} />
						) : null}
					</Pressable>
				))}
			</ScrollView>
		</BottomSheet>
	);
}
