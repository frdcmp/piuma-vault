import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AlertsField from "../components/AlertsField";
import BottomSheet from "../components/BottomSheet";
import DateTimePickerField from "../components/DateTimePickerField";
import ManageBucketsSheet from "../components/ManageBucketsSheet";
import TagPicker from "../components/TagPicker";
import TimeAgo from "../components/TimeAgo";
import { useTagsLiveUpdates, useTagTree } from "../queries/tagsQuery";
import {
	useCreateRecurringTask,
	useCreateTask,
	useDeleteRecurringTask,
	useDeleteTask,
	useRecurringTasks,
	useTasks,
	useTasksLiveUpdates,
	useToggleTask,
	useUpdateTask,
} from "../queries/tasksQuery";
import { formatDate } from "../utils/dateTime";
import { tagColor } from "../utils/tagColor";
import { colors, mono as MONO } from "../utils/theme";

const PRIORITY = ["none", "low", "med", "high"];
// Checkbox tint by priority: none → muted, low → green, med → yellow, high → red.
const PRIORITY_COLOR = [
	colors.muted,
	colors.accent2,
	colors.accent,
	colors.accent3,
];
const DOW = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DOW_LABEL = {
	MO: "M",
	TU: "T",
	WE: "W",
	TH: "T",
	FR: "F",
	SA: "S",
	SU: "S",
};

const buildRrule = (freq, byday) => {
	const parts = [`FREQ=${freq}`];
	if (freq === "WEEKLY" && byday.length) parts.push(`BYDAY=${byday.join(",")}`);
	return parts.join(";");
};

const ALL = { key: "all", names: null, label: "all" };

export default function TasksScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	useTasksLiveUpdates(); // refetch when tasks change on another device
	useTagsLiveUpdates("tasks"); // keep the bucket/tag tree + counts fresh
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const { data: tree } = useTagTree("tasks");
	const toggleTask = useToggleTask();
	const deleteRecurring = useDeleteRecurringTask();

	const [taskSheet, setTaskSheet] = useState(null); // { task } | {} | null
	const [recSheet, setRecSheet] = useState(false);
	const [manageSheet, setManageSheet] = useState(false);
	const [sel, setSel] = useState(ALL); // { key, names, label }
	const [expanded, setExpanded] = useState(null); // bucket/inbox key whose tags show
	const [showRecurring, setShowRecurring] = useState(false); // chip-row view toggle
	const [tagQuery, setTagQuery] = useState("");

	const oneOff = tasks.filter((t) => !t.recurrence_id);

	const buckets = tree?.buckets ?? [];
	const inbox = tree?.inbox ?? [];
	const q = tagQuery.trim().toLowerCase();

	// Which group (bucket id / "inbox") owns a tag name — used to keep the second
	// chip row expanded when a tag is tapped directly off a task.
	const groupKeyForTag = (name) => {
		for (const b of buckets) {
			if (b.tags.some((t) => t.name === name)) return `bucket:${b.id}`;
		}
		if (inbox.some((t) => t.name === name)) return "inbox";
		return null;
	};

	// Tags shown in the second row, for the currently expanded group.
	const expandedTags = (() => {
		if (!expanded) return [];
		const src =
			expanded === "inbox"
				? inbox
				: (buckets.find((b) => `bucket:${b.id}` === expanded)?.tags ?? []);
		return q ? src.filter((t) => t.name.includes(q)) : src;
	})();

	// `sel.names` is null for "all", else the set of tag names the selection
	// matches (a single tag, every tag in a bucket, or the Inbox group).
	const visible = sel.names
		? oneOff.filter((t) => t.tags?.some((n) => sel.names.includes(n)))
		: oneOff;
	// Highest priority first; within a priority tier, cluster tasks that share
	// tags (by normalized tag signature). Untagged tasks (→ "￿") trail.
	const pending = visible
		.filter((t) => !t.done)
		.sort((a, b) => {
			const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
			if (byPriority !== 0) return byPriority;
			const ka = (a.tags ?? []).slice().sort().join(",") || "￿";
			const kb = (b.tags ?? []).slice().sort().join(",") || "￿";
			return ka.localeCompare(kb);
		});
	const done = visible.filter((t) => t.done);

	// The id of the task whose toggle is in flight, so we can spin just its box.
	const togglingId = toggleTask.isPending ? toggleTask.variables : null;

	const selectAll = () => {
		setShowRecurring(false);
		setSel(ALL);
		setExpanded(null);
	};
	const selectBucket = (b) => {
		setShowRecurring(false);
		setSel({
			key: `bucket:${b.id}`,
			names: b.tags.map((t) => t.name),
			label: b.name,
		});
		setExpanded((e) => (e === `bucket:${b.id}` ? null : `bucket:${b.id}`));
	};
	const selectInbox = () => {
		setShowRecurring(false);
		setSel({ key: "inbox", names: inbox.map((t) => t.name), label: "inbox" });
		setExpanded((e) => (e === "inbox" ? null : "inbox"));
	};
	const selectTag = (name) => {
		setShowRecurring(false);
		setSel({ key: `tag:${name}`, names: [name], label: `#${name}` });
		setExpanded(groupKeyForTag(name));
	};

	return (
		<View style={[s.root, { paddingTop: insets.top }]}>
			<View style={s.header}>
				<Pressable onPress={() => navigation.goBack()} hitSlop={10}>
					<Ionicons name="chevron-back" size={22} color={colors.text} />
				</Pressable>
				<Text style={s.title}>☑ Tasks</Text>
				<View style={s.headerRight}>
					<Pressable onPress={() => setManageSheet(true)} hitSlop={10}>
						<Ionicons name="pricetags-outline" size={20} color={colors.muted} />
					</Pressable>
					<Pressable
						onPress={() =>
							setTaskSheet({
								defaultTags: sel.key.startsWith("tag:") ? sel.names : [],
							})
						}
						hitSlop={10}
					>
						<Ionicons name="add" size={24} color={colors.accent} />
					</Pressable>
				</View>
			</View>

			<View style={s.chipBar}>
				<View style={s.tagSearchRow}>
					<Ionicons name="search" size={14} color={colors.muted} />
					<TextInput
						style={s.tagSearch}
						value={tagQuery}
						onChangeText={setTagQuery}
						placeholder="Filter tags"
						placeholderTextColor={colors.muted}
						autoCapitalize="none"
						autoCorrect={false}
					/>
					{tagQuery ? (
						<Pressable onPress={() => setTagQuery("")} hitSlop={8}>
							<Ionicons name="close" size={14} color={colors.muted} />
						</Pressable>
					) : null}
				</View>
				{/* Row 1 — buckets (primary) */}
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
					contentContainerStyle={s.chipRow}
				>
					<Chip
						label="all"
						count={oneOff.length}
						active={!showRecurring && sel.key === "all"}
						onPress={selectAll}
					/>
					{buckets.map((b) => (
						<Chip
							key={b.id}
							label={b.name}
							count={b.tags.reduce((a, t) => a + (t.count || 0), 0)}
							color={b.color || undefined}
							active={!showRecurring && expanded === `bucket:${b.id}`}
							onPress={() => selectBucket(b)}
						/>
					))}
					{inbox.length ? (
						<Chip
							label="⊕ inbox"
							count={inbox.reduce((a, t) => a + (t.count || 0), 0)}
							active={!showRecurring && expanded === "inbox"}
							onPress={selectInbox}
						/>
					) : null}
					<Chip
						label="⟳ recurring"
						count={recurring.length}
						active={showRecurring}
						onPress={() => setShowRecurring(true)}
					/>
				</ScrollView>

				{/* Row 2 — tags of the expanded bucket (secondary) */}
				{!showRecurring && expanded ? (
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						keyboardShouldPersistTaps="handled"
						contentContainerStyle={[s.chipRow, s.chipRowSub]}
					>
						{expandedTags.map((t) => (
							<Chip
								key={t.id}
								label={`#${t.name}`}
								count={t.count}
								color={t.color || tagColor(t.name)}
								active={sel.key === `tag:${t.name}`}
								onPress={() => selectTag(t.name)}
							/>
						))}
						{expandedTags.length === 0 ? (
							<Text style={s.empty}>no tags here</Text>
						) : null}
					</ScrollView>
				) : null}
			</View>

			{showRecurring ? (
				<ScrollView contentContainerStyle={s.scroll}>
					<View style={s.recHead}>
						<Text style={s.section}>RECURRING · {recurring.length}</Text>
						<Pressable onPress={() => setRecSheet(true)} hitSlop={10}>
							<Text style={s.addRec}>+ recurring</Text>
						</Pressable>
					</View>
					{recurring.length === 0 ? (
						<Text style={s.empty}>No recurring tasks. Add a workout plan?</Text>
					) : null}
					{recurring.map((r) => (
						<View key={r.id} style={[s.taskRow, !r.active && s.dim]}>
							<Text style={s.check}>⟳</Text>
							<View style={s.taskMain}>
								<Text style={s.taskTitle}>{r.title}</Text>
								<View style={s.metaRow}>
									<Text style={[s.meta, s.rrule]}>{r.rrule}</Text>
									<Text style={[s.meta, s.due]}>
										from {formatDate(r.dtstart)}
									</Text>
									{!r.active ? (
										<Text style={[s.meta, s.tag]}>paused</Text>
									) : null}
								</View>
							</View>
							<Pressable
								onPress={() => deleteRecurring.mutate(r.id)}
								hitSlop={8}
							>
								<Ionicons name="close" size={16} color={colors.muted} />
							</Pressable>
						</View>
					))}
				</ScrollView>
			) : (
				<ScrollView contentContainerStyle={s.scroll}>
					<Text style={s.section}>
						{sel.key !== "all" ? `${sel.label} · ` : "TO DO · "}
						{pending.length}
					</Text>
					{pending.length === 0 ? (
						<Text style={s.empty}>Nothing to do. Piuma approves.</Text>
					) : null}
					{pending.map((t) => (
						<View key={t.id} style={s.taskRow}>
							<Pressable
								onPress={() => toggleTask.mutate(t.id)}
								hitSlop={8}
								disabled={togglingId === t.id}
							>
								{togglingId === t.id ? (
									<ActivityIndicator
										size="small"
										color={PRIORITY_COLOR[t.priority]}
										style={s.checkSpin}
									/>
								) : (
									<Text
										style={[s.check, { color: PRIORITY_COLOR[t.priority] }]}
									>
										☐
									</Text>
								)}
							</Pressable>
							<Pressable
								style={s.taskMain}
								onPress={() => setTaskSheet({ task: t })}
							>
								<Text style={s.taskTitle}>{t.title}</Text>
								<View style={s.metaRow}>
									{t.priority ? (
										<Text style={[s.meta, s.prio]}>{PRIORITY[t.priority]}</Text>
									) : null}
									{t.due_at ? (
										<Text style={[s.meta, s.due]}>
											due <TimeAgo value={t.due_at} />
										</Text>
									) : null}
									{(t.tags || []).map((tag) => (
										<Pressable
											key={tag}
											hitSlop={4}
											onPress={() => selectTag(tag)}
										>
											<Text style={[s.meta, { color: tagColor(tag) }]}>
												#{tag}
											</Text>
										</Pressable>
									))}
								</View>
							</Pressable>
						</View>
					))}

					{done.length > 0 ? (
						<>
							<Text style={s.section}>DONE · {done.length}</Text>
							{done.map((t) => (
								<View key={t.id} style={[s.taskRow, s.dim]}>
									<Pressable
										onPress={() => toggleTask.mutate(t.id)}
										hitSlop={8}
										disabled={togglingId === t.id}
									>
										{togglingId === t.id ? (
											<ActivityIndicator
												size="small"
												color={colors.accent2}
												style={s.checkSpin}
											/>
										) : (
											<Text style={s.check}>☑</Text>
										)}
									</Pressable>
									<Pressable
										style={s.taskMain}
										onPress={() => setTaskSheet({ task: t })}
									>
										<Text style={[s.taskTitle, s.strike]}>{t.title}</Text>
									</Pressable>
								</View>
							))}
						</>
					) : null}
				</ScrollView>
			)}

			{taskSheet ? (
				<TaskSheet
					task={taskSheet.task}
					defaultTags={taskSheet.defaultTags}
					onClose={() => setTaskSheet(null)}
				/>
			) : null}
			{recSheet ? <RecurringSheet onClose={() => setRecSheet(false)} /> : null}
			{manageSheet ? (
				<ManageBucketsSheet onClose={() => setManageSheet(false)} />
			) : null}
		</View>
	);
}

// ── Filter chip (tag group / recurring) ─────────────────────────────────────

function Chip({ label, count, active, color, onPress }) {
	return (
		<Pressable
			style={[s.chip, active && s.chipOn]}
			onPress={onPress}
			hitSlop={6}
		>
			<Text style={[s.chipText, active && s.chipTextOn, color && { color }]}>
				{label}
			</Text>
			<Text style={[s.chipCount, active && s.chipTextOn]}>{count}</Text>
		</Pressable>
	);
}

// ── Create-task sheet ──────────────────────────────────────────────────────

function TaskSheet({ task, defaultTags = [], onClose }) {
	const editing = !!task;
	const createTask = useCreateTask();
	const updateTask = useUpdateTask();
	const deleteTask = useDeleteTask();
	const [title, setTitle] = useState(task?.title ?? "");
	const [dueAt, setDueAt] = useState(task?.due_at ?? null);
	const [priority, setPriority] = useState(task?.priority ?? 0);
	const [tags, setTags] = useState(task?.tags ?? defaultTags);
	const [alerts, setAlerts] = useState(task?.alerts ?? []);

	const save = () => {
		if (!title.trim()) return;
		// Alerts fire relative to the due date, so they need one as an anchor.
		if (alerts.length > 0 && !dueAt) return;
		const payload = {
			title: title.trim(),
			due_at: dueAt || null,
			priority,
			tags,
			alerts,
		};
		if (editing) {
			updateTask.mutate({ id: task.id, ...payload }, { onSuccess: onClose });
		} else {
			createTask.mutate(payload, { onSuccess: onClose });
		}
	};

	const remove = () => deleteTask.mutate(task.id, { onSuccess: onClose });

	const saving = createTask.isPending || updateTask.isPending;
	const deleting = deleteTask.isPending;

	// "details" swaps the sheet body in place rather than stacking a second
	// modal — DateTimePickerField already opens its own sheet, and RN can't
	// reliably nest three modals deep (see BottomSheet.js).
	const [panel, setPanel] = useState("main");

	const tagCount = tags.length;
	const detailSummary =
		[
			dueAt ? "due set" : null,
			priority ? PRIORITY[priority] : null,
			tagCount ? `${tagCount} tag${tagCount > 1 ? "s" : ""}` : null,
			alerts.length
				? `${alerts.length} alert${alerts.length > 1 ? "s" : ""}`
				: null,
		]
			.filter(Boolean)
			.join(" · ") || "due, priority, tags, alerts";

	return (
		<BottomSheet
			visible
			onClose={onClose}
			title={
				panel === "details"
					? "Task details"
					: editing
						? "Edit task"
						: "New task"
			}
		>
			{panel === "main" ? (
				<View style={s.form}>
					<Text style={s.label}>Task</Text>
					<TextInput
						style={[s.input, s.titleInput]}
						value={title}
						onChangeText={setTitle}
						placeholder="What needs doing?"
						placeholderTextColor={colors.muted}
						multiline
						textAlignVertical="top"
					/>
					<Pressable style={s.detailsBtn} onPress={() => setPanel("details")}>
						<Ionicons name="options-outline" size={16} color={colors.text} />
						<Text style={s.detailsBtnText} numberOfLines={1}>
							{detailSummary}
						</Text>
						<Ionicons name="chevron-forward" size={16} color={colors.muted} />
					</Pressable>
					<Pressable
						style={[s.saveBtn, saving && s.btnDisabled]}
						onPress={save}
						disabled={saving || deleting}
					>
						{saving ? (
							<ActivityIndicator size="small" color="#000" />
						) : (
							<Text style={s.saveBtnText}>Save</Text>
						)}
					</Pressable>
					{editing ? (
						<Pressable
							style={[s.deleteBtn, deleting && s.btnDisabled]}
							onPress={remove}
							disabled={saving || deleting}
						>
							{deleting ? (
								<ActivityIndicator size="small" color={colors.accent3} />
							) : (
								<Text style={s.deleteBtnText}>Delete task</Text>
							)}
						</Pressable>
					) : null}
				</View>
			) : (
				<View style={s.form}>
					<Pressable style={s.backRow} onPress={() => setPanel("main")}>
						<Ionicons name="chevron-back" size={16} color={colors.accent2} />
						<Text style={s.backText}>Back to task</Text>
					</Pressable>
					<Text style={s.label}>Due</Text>
					<DateTimePickerField
						value={dueAt}
						onChange={(v) => {
							setDueAt(v);
							// Alerts are anchored to the due date — drop them if it's cleared.
							if (!v) setAlerts([]);
						}}
						mode="datetime"
						placeholder="No due date"
					/>
					<Text style={s.label}>Priority</Text>
					<View style={s.prioRow}>
						{PRIORITY.map((p, i) => (
							<Pressable
								key={p}
								style={[s.prioBtn, priority === i && s.prioBtnOn]}
								onPress={() => setPriority(i)}
							>
								<Text
									style={[s.prioBtnText, priority === i && s.prioBtnTextOn]}
								>
									{p}
								</Text>
							</Pressable>
						))}
					</View>
					<Text style={s.label}>Tags</Text>
					<TagPicker value={tags} onChange={setTags} />
					<Text style={s.label}>Alerts</Text>
					{dueAt ? (
						<AlertsField value={alerts} onChange={setAlerts} />
					) : (
						<Text style={s.hint}>set a due date to add alerts</Text>
					)}
					<Pressable style={s.saveBtn} onPress={() => setPanel("main")}>
						<Text style={s.saveBtnText}>Done</Text>
					</Pressable>
				</View>
			)}
		</BottomSheet>
	);
}

// ── Create-recurring sheet ──────────────────────────────────────────────────

function RecurringSheet({ onClose }) {
	const create = useCreateRecurringTask();
	const [title, setTitle] = useState("");
	const [freq, setFreq] = useState("WEEKLY");
	const [byday, setByday] = useState(["MO", "WE", "FR"]);
	const [dtstart, setDtstart] = useState(null);
	const [tags, setTags] = useState([]);
	const [alerts, setAlerts] = useState([]);

	const toggleDay = (d) =>
		setByday((prev) =>
			prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
		);

	const save = () => {
		if (!title.trim()) return;
		if (freq === "WEEKLY" && byday.length === 0) return;
		create.mutate(
			{
				title: title.trim(),
				rrule: buildRrule(freq, byday),
				dtstart: dtstart || new Date().toISOString(),
				tags,
				alerts,
			},
			{ onSuccess: onClose },
		);
	};

	return (
		<BottomSheet visible onClose={onClose} title="New recurring task">
			<View style={s.form}>
				<Text style={s.label}>Title</Text>
				<TextInput
					style={s.input}
					value={title}
					onChangeText={setTitle}
					placeholder="Leg day"
					placeholderTextColor={colors.muted}
				/>
				<Text style={s.label}>Repeats</Text>
				<View style={s.prioRow}>
					{["DAILY", "WEEKLY", "MONTHLY"].map((f) => (
						<Pressable
							key={f}
							style={[s.prioBtn, freq === f && s.prioBtnOn]}
							onPress={() => setFreq(f)}
						>
							<Text style={[s.prioBtnText, freq === f && s.prioBtnTextOn]}>
								{f.toLowerCase()}
							</Text>
						</Pressable>
					))}
				</View>
				{freq === "WEEKLY" ? (
					<>
						<Text style={s.label}>On</Text>
						<View style={s.dowRow}>
							{DOW.map((d) => (
								<Pressable
									key={d}
									style={[s.dowBtn, byday.includes(d) && s.dowBtnOn]}
									onPress={() => toggleDay(d)}
								>
									<Text style={[s.dowText, byday.includes(d) && s.dowTextOn]}>
										{DOW_LABEL[d]}
									</Text>
								</Pressable>
							))}
						</View>
					</>
				) : null}
				<Text style={s.label}>Starts</Text>
				<DateTimePickerField
					value={dtstart}
					onChange={setDtstart}
					mode="datetime"
					clearable={false}
					placeholder="Pick start"
				/>
				<Text style={s.label}>Tags</Text>
				<TagPicker value={tags} onChange={setTags} />
				<Text style={s.hint}>rule: {buildRrule(freq, byday)}</Text>
				<Text style={s.label}>Alerts</Text>
				<AlertsField value={alerts} onChange={setAlerts} />
				<Pressable style={s.saveBtn} onPress={save}>
					<Text style={s.saveBtnText}>Save</Text>
				</Pressable>
			</View>
		</BottomSheet>
	);
}

const s = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	header: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	headerRight: { flexDirection: "row", alignItems: "center", gap: 16 },
	title: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 16,
		fontWeight: "700",
		letterSpacing: 1,
	},
	chipBar: {
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	tagSearchRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		marginHorizontal: 16,
		marginTop: 10,
		paddingHorizontal: 10,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
	},
	tagSearch: {
		flex: 1,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 13,
		paddingVertical: 7,
	},
	chipRow: {
		flexDirection: "row",
		gap: 6,
		paddingHorizontal: 16,
		paddingVertical: 10,
	},
	chipRowSub: {
		paddingTop: 0,
		paddingBottom: 10,
	},
	chip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 10,
		paddingVertical: 6,
	},
	chipOn: { borderColor: colors.accent2, backgroundColor: colors.bg },
	chipText: { color: colors.text, fontFamily: MONO, fontSize: 12 },
	chipTextOn: { color: colors.accent2 },
	chipCount: { color: colors.muted, fontFamily: MONO, fontSize: 11 },
	scroll: { padding: 16, paddingBottom: 48 },
	section: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1.5,
		textTransform: "uppercase",
		marginTop: 16,
		marginBottom: 8,
	},
	recHead: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	addRec: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
		letterSpacing: 0.5,
		marginTop: 16,
	},
	empty: {
		color: colors.muted,
		fontFamily: MONO,
		fontStyle: "italic",
		fontSize: 12,
		padding: 4,
	},
	taskRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		backgroundColor: colors.bgSoft,
		borderWidth: 1,
		borderColor: colors.border,
		// Square edges = pixel.
		paddingHorizontal: 10,
		paddingVertical: 9,
		marginBottom: 6,
	},
	dim: { opacity: 0.55 },
	check: { color: colors.accent2, fontFamily: MONO, fontSize: 18 },
	// Match the ☐ glyph footprint so swapping in the spinner doesn't shift the row.
	checkSpin: { width: 18, height: 18 },
	taskMain: { flex: 1 },
	taskTitle: { color: colors.text, fontFamily: MONO, fontSize: 14 },
	strike: { textDecorationLine: "line-through", flex: 1 },
	metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 3 },
	meta: { fontFamily: MONO, fontSize: 11, letterSpacing: 0.3 },
	due: { color: colors.accent },
	tag: { color: colors.accent2 },
	rrule: { color: colors.accent4 },
	prio: { color: colors.accent, textTransform: "uppercase" },
	// Forms
	form: { paddingHorizontal: 16, paddingTop: 2, gap: 4 },
	label: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
		marginTop: 5,
	},
	input: {
		backgroundColor: colors.bg,
		borderWidth: 1,
		borderColor: colors.border,
		color: colors.text,
		fontFamily: MONO,
		paddingHorizontal: 10,
		paddingVertical: 7,
		fontSize: 14,
	},
	titleInput: {
		minHeight: 110,
		fontSize: 16,
		lineHeight: 23,
		paddingTop: 8,
	},
	detailsBtn: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 10,
		paddingVertical: 9,
		marginTop: 2,
	},
	detailsBtnText: {
		flex: 1,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 13,
	},
	backRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		paddingVertical: 4,
		marginBottom: 4,
	},
	backText: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 13,
		fontWeight: "700",
		letterSpacing: 0.5,
	},
	prioRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
	prioBtn: {
		borderWidth: 1,
		borderColor: colors.border,
		paddingHorizontal: 14,
		paddingVertical: 7,
		backgroundColor: colors.bg,
	},
	prioBtnOn: { backgroundColor: colors.accent, borderColor: colors.accent },
	prioBtnText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
		letterSpacing: 0.5,
		textTransform: "uppercase",
	},
	prioBtnTextOn: { color: "#000", fontWeight: "700" },
	dowRow: { flexDirection: "row", gap: 6 },
	dowBtn: {
		width: 36,
		height: 36,
		borderWidth: 1,
		borderColor: colors.border,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.bg,
	},
	dowBtnOn: { backgroundColor: colors.accent2, borderColor: colors.accent2 },
	dowText: { color: colors.muted, fontFamily: MONO, fontSize: 13 },
	dowTextOn: { color: "#000", fontWeight: "700" },
	hint: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		letterSpacing: 0.5,
		marginTop: 4,
	},
	saveBtn: {
		backgroundColor: colors.accent,
		borderWidth: 2,
		borderColor: colors.accent,
		paddingVertical: 9,
		alignItems: "center",
		marginTop: 10,
	},
	saveBtnText: {
		color: "#000",
		fontFamily: MONO,
		fontWeight: "700",
		fontSize: 14,
		letterSpacing: 1.5,
		textTransform: "uppercase",
	},
	btnDisabled: { opacity: 0.6 },
	deleteBtn: {
		borderWidth: 1,
		borderColor: colors.accent3,
		paddingVertical: 8,
		alignItems: "center",
		marginTop: 6,
	},
	deleteBtnText: {
		color: colors.accent3,
		fontFamily: MONO,
		fontWeight: "700",
		fontSize: 13,
		letterSpacing: 1,
		textTransform: "uppercase",
	},
});
