import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import DraggableFlatList, {
	ScaleDecorator,
} from "react-native-draggable-flatlist";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AlertsField from "../components/AlertsField";
import BottomSheet from "../components/BottomSheet";
import DateTimePickerField from "../components/DateTimePickerField";
import ManageBucketsSheet from "../components/ManageBucketsSheet";
import ScreenHeader from "../components/ScreenHeader";
import SpriteLoader from "../components/SpriteLoader";
import TagPicker from "../components/TagPicker";
import TimeAgo from "../components/TimeAgo";
import {
	useBuckets,
	useTagRegistry,
	useTagsLiveUpdates,
} from "../queries/tagsQuery";
import {
	useCreateRecurringTask,
	useCreateTask,
	useDeleteRecurringTask,
	useDeleteTask,
	useDoneTasks,
	useRecurringTasks,
	useTask,
	useTasks,
	useTasksLiveUpdates,
	useToggleTask,
	useUpdateTask,
} from "../queries/tasksQuery";
import { dueBucket, formatDate } from "../utils/dateTime";
import { rankBefore, rankBetween } from "../utils/rank";
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
// Faint card-background wash per priority (low-alpha hex on the priority hue),
// matching the web cards. Index 0 (none) = no tint.
const PRIORITY_TINT = [
	"transparent",
	`${colors.accent2}14`,
	`${colors.accent}14`,
	`${colors.accent3}1f`,
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

// Sentinel row that renders the "DONE · N" divider between the to-do and
// completed sections. Lives in the list data (not a footer) so the completed
// rows below it are virtualized and scroll/​paginate correctly.
const DONE_HEADER_ID = "__done_header__";

// `alerts` arrives as a JSON array of { offset_minutes, channels? } objects.
const hasAlerts = (t) => Array.isArray(t.alerts) && t.alerts.length > 0;

export default function TasksScreen({ navigation, route }) {
	const insets = useSafeAreaInsets();
	useTasksLiveUpdates(); // refetch when tasks change on another device
	useTagsLiveUpdates("tasks"); // keep buckets + tags fresh
	// Only the to-do tasks are loaded in full (bounded, and they drive the
	// drag-order + bucket/tag counts). Completed tasks are paged separately
	// (`useDoneTasks` below) so a long history never loads at once.
	const { data: tasks = [], isLoading: tasksLoading } = useTasks({
		done: false,
	});
	const { data: recurring = [], isLoading: recurringLoading } =
		useRecurringTasks();
	const { data: buckets = [] } = useBuckets();
	const { data: tagRegistry = [] } = useTagRegistry();
	const toggleTask = useToggleTask();
	const updateTask = useUpdateTask();
	const deleteRecurring = useDeleteRecurringTask();

	const [taskSheet, setTaskSheet] = useState(null); // { task } | {} | null
	const [recSheet, setRecSheet] = useState(false);
	const [manageSheet, setManageSheet] = useState(false);

	// Deep-link: a Tasks route param `taskId` (chat link / "Go" action) opens that
	// task's sheet AND filters the list to its bucket + tags, so it shows in
	// context. Resolve from the loaded to-do list, else fetch by id (covers
	// completed tasks, which aren't in the to-do page). Clear the param after.
	const deepTaskId = route?.params?.taskId;
	const { data: fetchedDeepTask } = useTask(
		deepTaskId && !tasks.some((t) => t.id === deepTaskId) ? deepTaskId : null,
	);
	useEffect(() => {
		if (!deepTaskId) return;
		const task = tasks.find((t) => t.id === deepTaskId) || fetchedDeepTask;
		if (!task) return; // wait for the list or the fallback fetch to resolve
		setTaskSheet({ task });
		setShowRecurring(false);
		setTags(task.tags ?? []);
		if (task.bucket_id) {
			const b = buckets.find((x) => x.id === task.bucket_id);
			setBucketSel(
				b ? { key: `bucket:${b.id}`, bucketId: b.id, label: b.name } : ALL,
			);
		} else {
			setBucketSel({ key: "nobucket", label: "no bucket" });
		}
		navigation.setParams({ taskId: undefined });
	}, [deepTaskId, fetchedDeepTask, tasks, buckets, navigation]);
	// Bucket + tag filter independently and combine (AND). `bucketSel` is the
	// bucket constraint (all / nobucket / a specific bucket); `tags` is the active
	// tag (single, kept as an array so it composes with the bucket). "all" resets
	// both; switching bucket clears the tag.
	const [bucketSel, setBucketSel] = useState(ALL); // { key, bucketId?, label }
	const [tags, setTags] = useState([]); // active tag names (0 or 1)
	const [showRecurring, setShowRecurring] = useState(false); // chip-row view toggle
	const [tagQuery, setTagQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false); // tag-search field revealed?

	const oneOff = tasks.filter((t) => !t.recurrence_id);
	const q = tagQuery.trim().toLowerCase();

	// Per-bucket colour lookup + tag colour from the registry (derived fallback).
	const bucketById = new Map(buckets.map((b) => [b.id, b]));
	const tagColorOf = (name) =>
		tagRegistry.find((r) => r.name === name)?.color || tagColor(name);

	// The tag row reflects the current bucket scope: when a bucket (or "no
	// bucket") is selected, only tags used by tasks in that bucket are shown,
	// with counts scoped to it. Otherwise ("all") → all tags. Done tasks are
	// excluded so only tags with actual to-dos appear (counts reflect to-dos).
	const tagScope = (
		bucketSel.key.startsWith("bucket:")
			? oneOff.filter((t) => t.bucket_id === bucketSel.bucketId)
			: bucketSel.key === "nobucket"
				? oneOff.filter((t) => !t.bucket_id)
				: oneOff
	).filter((t) => !t.done);
	const tagCounts = new Map();
	for (const t of tagScope)
		for (const n of t.tags ?? []) tagCounts.set(n, (tagCounts.get(n) ?? 0) + 1);
	const tagList = [...tagCounts.keys()]
		.filter((n) => !q || n.includes(q))
		.sort();
	const noBucketCount = oneOff.filter((t) => !t.bucket_id).length;

	// Apply the bucket constraint, then narrow by the active tag — the two
	// combine, so the bucket stays in effect while a tag filters on top.
	let visible = oneOff;
	if (bucketSel.key.startsWith("bucket:"))
		visible = visible.filter((t) => t.bucket_id === bucketSel.bucketId);
	else if (bucketSel.key === "nobucket")
		visible = visible.filter((t) => !t.bucket_id);
	if (tags.length)
		visible = visible.filter((t) => t.tags?.some((n) => tags.includes(n)));
	// The API returns tasks already in manual order (by `rank`); filtering keeps
	// it. `serverPending` is the source of truth; `pending` mirrors it but holds
	// the user's in-progress drag so a reorder doesn't snap back while the rank
	// PUT round-trips.
	const serverPending = visible.filter((t) => !t.done);

	const [pending, setPending] = useState([]);
	// Re-sync to the server order only when the *set* of pending tasks changes
	// (add / remove / complete / filter switch) — not on reorder, so an
	// optimistic drag isn't clobbered by the refetch it triggers.
	const setSig = [...serverPending.map((t) => t.id)].sort().join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-sync keyed on the id-set, not order
	useEffect(() => {
		setPending(serverPending);
	}, [setSig]);

	// Completed tasks, paged from the server. The query is scoped to the active
	// bucket/tag so the DONE block mirrors the to-do filter; it pages in as the
	// user scrolls to the end. Disabled in the recurring view (no DONE block).
	const doneFilter = {
		...(bucketSel.key.startsWith("bucket:")
			? { bucket: bucketSel.bucketId }
			: bucketSel.key === "nobucket"
				? { no_bucket: true }
				: {}),
		...(tags.length ? { tag: tags[0] } : {}),
	};
	const {
		data: donePages,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isLoading: doneLoading,
	} = useDoneTasks(doneFilter, { enabled: !showRecurring });
	const done = donePages?.pages.flat() ?? [];
	const loadMoreDone = () => {
		if (hasNextPage && !isFetchingNextPage) fetchNextPage();
	};

	// Group the to-do rows by due date: OVERDUE → DUE TODAY → NEXT DUE (each
	// sorted by due date), then TO DO (no due date, kept in manual/drag order).
	// Only the dateless TO DO group is reorderable.
	const byDueAsc = (a, b) => new Date(a.due_at) - new Date(b.due_at);
	const overdue = pending
		.filter((t) => dueBucket(t.due_at) === "overdue")
		.sort(byDueAsc);
	const dueToday = pending
		.filter((t) => dueBucket(t.due_at) === "today")
		.sort(byDueAsc);
	const upcoming = pending
		.filter((t) => dueBucket(t.due_at) === "upcoming")
		.sort(byDueAsc);
	const noDate = pending.filter((t) => !t.due_at); // manual (rank) order

	// Section divider as a list row (so the rows under it stay virtualized).
	const hdr = (key, label, count) => ({
		id: `__hdr_${key}`,
		__header: true,
		label,
		count,
	});

	// One flat list: grouped to-do rows, then a DONE divider, then the
	// (virtualized, paginated) completed rows. Rendering completed tasks as real
	// items — not footer content — is what lets the list size and scroll to the
	// very bottom and fire onEndReached reliably.
	const showDoneSection = done.length > 0 || doneLoading;
	const listData = [
		...(overdue.length
			? [hdr("overdue", "OVERDUE", overdue.length), ...overdue]
			: []),
		...(dueToday.length
			? [hdr("today", "DUE TODAY", dueToday.length), ...dueToday]
			: []),
		...(upcoming.length
			? [hdr("upcoming", "NEXT DUE", upcoming.length), ...upcoming]
			: []),
		...(noDate.length ? [hdr("todo", "TO DO", noDate.length), ...noDate] : []),
		...(showDoneSection
			? [{ id: DONE_HEADER_ID, __header: true }, ...done]
			: []),
	];

	// Drop handler: only the dateless TO DO group is reorderable. Rebuild that
	// group's order from the dragged result (ignoring headers, dated rows and
	// completed rows), then mint a key strictly between the moved row's new
	// neighbours and persist it. Dated rows keep their (date) order regardless.
	const onDragEnd = ({ data, to }) => {
		const moved = data[to];
		if (!moved || moved.__header || moved.done || moved.due_at) return;
		const newNoDate = data.filter((t) => !t.__header && !t.done && !t.due_at);
		setPending([...pending.filter((t) => t.due_at), ...newNoDate]);
		const pos = newNoDate.findIndex((t) => t.id === moved.id);
		const before = newNoDate[pos - 1]?.rank ?? null;
		const after = newNoDate[pos + 1]?.rank ?? null;
		updateTask.mutate({ id: moved.id, rank: rankBetween(before, after) });
	};

	// Rank that drops a brand-new (dateless) task at the top of the TO DO group.
	const newTaskRank = () => rankBefore(noDate[0]?.rank);

	// The id of the task whose toggle is in flight, so we can spin just its box.
	const togglingId = toggleTask.isPending ? toggleTask.variables : null;

	const selectAll = () => {
		// Master reset — clear both the bucket and the tag.
		setShowRecurring(false);
		setBucketSel(ALL);
		setTags([]);
	};
	const selectBucket = (b) => {
		// Switching bucket resets the tag (the tag row is scoped to the bucket).
		setShowRecurring(false);
		setBucketSel({ key: `bucket:${b.id}`, bucketId: b.id, label: b.name });
		setTags([]);
	};
	const selectNoBucket = () => {
		setShowRecurring(false);
		setBucketSel({ key: "nobucket", label: "no bucket" });
		setTags([]);
	};
	// Tapping a tag on a task row selects just that tag, keeping the bucket.
	const selectTag = (name) => {
		setShowRecurring(false);
		setTags([name]);
	};
	// Tapping a tag chip toggles it (one at a time), keeping the bucket.
	const toggleTag = (name) => {
		setShowRecurring(false);
		setTags((prev) => (prev.includes(name) ? [] : [name]));
	};

	// Heading reflects the combined filter, e.g. "piuma-vault + #bug".
	const filterLabel = [
		bucketSel.key !== "all" ? bucketSel.label : null,
		...tags.map((t) => `#${t}`),
	]
		.filter(Boolean)
		.join(" + ");

	return (
		<View style={s.root}>
			<ScreenHeader
				title="Tasks"
				icon="checkbox-outline"
				onBack={() => navigation.goBack()}
				right={
					<>
						<Pressable onPress={() => setManageSheet(true)} hitSlop={10}>
							<Ionicons
								name="pricetags-outline"
								size={20}
								color={colors.muted}
							/>
						</Pressable>
						<Pressable
							onPress={() =>
								setTaskSheet({
									defaultTags: tags,
									defaultBucket: bucketSel.key.startsWith("bucket:")
										? bucketSel.bucketId
										: null,
									// New tasks land at the top of the list.
									newRank: newTaskRank(),
								})
							}
							hitSlop={10}
						>
							<Ionicons name="add" size={24} color={colors.accent} />
						</Pressable>
					</>
				}
			/>

			<View style={s.chipBar}>
				{/* Tag-search field — hidden until the search chip is tapped. */}
				{searchOpen ? (
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
							autoFocus
						/>
						<Pressable
							onPress={() => {
								setTagQuery("");
								setSearchOpen(false);
							}}
							hitSlop={8}
						>
							<Ionicons name="close" size={16} color={colors.muted} />
						</Pressable>
					</View>
				) : null}
				{/* Row 1 — buckets (task groups) */}
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
					contentContainerStyle={s.chipRow}
				>
					{/* Reveals the tag-search field. */}
					<Pressable
						style={[s.searchChip, searchOpen && s.chipOn]}
						onPress={() => setSearchOpen((o) => !o)}
						hitSlop={6}
					>
						<Ionicons
							name="search"
							size={14}
							color={searchOpen ? colors.accent2 : colors.muted}
						/>
					</Pressable>
					<Chip
						label="all"
						count={oneOff.length}
						active={!showRecurring && bucketSel.key === "all"}
						onPress={selectAll}
					/>
					{buckets.map((b) => (
						<Chip
							key={b.id}
							label={b.name}
							count={oneOff.filter((t) => t.bucket_id === b.id).length}
							color={b.color || undefined}
							swatch
							active={!showRecurring && bucketSel.key === `bucket:${b.id}`}
							onPress={() => selectBucket(b)}
						/>
					))}
					{noBucketCount ? (
						<Chip
							label="no bucket"
							count={noBucketCount}
							swatch
							active={!showRecurring && bucketSel.key === "nobucket"}
							onPress={selectNoBucket}
						/>
					) : null}
					<Chip
						label="⟳ recurring"
						count={recurring.length}
						active={showRecurring}
						onPress={() => setShowRecurring(true)}
					/>
				</ScrollView>

				{/* Row 2 — flat tags */}
				{!showRecurring && tagList.length ? (
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						keyboardShouldPersistTaps="handled"
						contentContainerStyle={[s.chipRow, s.chipRowSub]}
					>
						{tagList.map((name) => (
							<Chip
								key={name}
								label={`#${name}`}
								count={tagCounts.get(name)}
								color={tagColorOf(name)}
								active={tags.includes(name)}
								onPress={() => toggleTag(name)}
							/>
						))}
					</ScrollView>
				) : null}
			</View>

			{(showRecurring ? recurringLoading : tasksLoading) ? (
				/* Initial load — show the running mascot instead of an empty state,
				   which would otherwise read as "no tasks" before data arrives. */
				<SpriteLoader message="Loading tasks" />
			) : showRecurring ? (
				<ScrollView
					style={s.listFlex}
					contentContainerStyle={[
						s.scroll,
						{ paddingBottom: insets.bottom + 48 },
					]}
				>
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
				/* Long-press a row to drag it; tap still opens the task. The list is
				   its own scroller (a FlatList), so the section header and the DONE
				   block ride along as header/footer rather than nesting in a
				   ScrollView. */
				<DraggableFlatList
					data={listData}
					onDragEnd={onDragEnd}
					keyExtractor={(t) => t.id}
					// flex:1 on the OUTER container is what gives the list a bounded
					// scroll viewport. Without it the dragger sizes to content and the
					// tail (last rows + the pager/spinner) spills off-screen under the
					// nav bar, and onEndReached never fires.
					containerStyle={s.listContainer}
					style={s.listFlex}
					// Bottom clearance comes from the footer spacer below.
					contentContainerStyle={[s.scroll, { paddingBottom: 0 }]}
					activationDistance={12}
					onEndReached={loadMoreDone}
					onEndReachedThreshold={0.4}
					ListHeaderComponent={
						<>
							{filterLabel ? (
								<Text style={s.filterHeading}>{filterLabel}</Text>
							) : null}
							{pending.length === 0 ? (
								<Text style={s.empty}>Nothing to do. Piuma approves.</Text>
							) : null}
						</>
					}
					ListFooterComponent={
						/* Always rendered so the last row clears the Android nav bar
						   (a real list item the dragger can't mis-measure); holds the
						   pager when more completed tasks remain. */
						<View style={{ paddingBottom: insets.bottom + 56 }}>
							{hasNextPage ? (
								<Pressable style={s.loadMore} onPress={loadMoreDone}>
									<ActivityIndicator size="small" color={colors.muted} />
									<Text style={s.loadMoreText}>
										{isFetchingNextPage ? "Loading…" : "Show more completed"}
									</Text>
								</Pressable>
							) : null}
						</View>
					}
					renderItem={({ item: t, drag, isActive }) => {
						// Section divider rows (OVERDUE / DUE TODAY / NEXT DUE / TO DO,
						// and the DONE divider which also shows the "+more" hint).
						if (t.__header) {
							return (
								<Text style={s.section}>
									{t.id === DONE_HEADER_ID
										? `DONE · ${done.length}${hasNextPage ? "+" : ""}`
										: `${t.label} · ${t.count}`}
								</Text>
							);
						}
						// Completed row — non-draggable, dimmed, strikethrough.
						if (t.done) {
							return (
								<View style={[s.taskRow, s.dim]}>
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
							);
						}
						const bucket = bucketById.get(t.bucket_id);
						const tagsOf = t.tags || [];
						// Only dateless TO DO rows are draggable; dated rows are ordered
						// by their due date, so dragging them is disabled.
						const canDrag = !t.due_at;
						const overdueDue = dueBucket(t.due_at) === "overdue";
						return (
							<ScaleDecorator>
								<View
									style={[
										s.taskRow,
										t.priority
											? {
													borderLeftColor: PRIORITY_COLOR[t.priority],
													backgroundColor: PRIORITY_TINT[t.priority],
												}
											: null,
										isActive && s.taskRowActive,
									]}
								>
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
										onLongPress={canDrag ? drag : undefined}
										delayLongPress={200}
									>
										{/* Title fills the row (priority shows via the card's left
										   bar). */}
										<Text style={s.taskTitle} numberOfLines={2}>
											{t.title}
										</Text>
										{/* Meta line: bucket + due on the left, tags on the right. */}
										{bucket || t.due_at || tagsOf.length || hasAlerts(t) ? (
											<View style={s.metaRow}>
												<View style={s.metaLeft}>
													{bucket ? (
														<View style={s.bucketTag}>
															<View
																style={[
																	s.bucketSwatch,
																	bucket.color
																		? {
																				backgroundColor: bucket.color,
																				borderColor: bucket.color,
																			}
																		: null,
																]}
															/>
															<Text
																style={[s.meta, s.bucketName]}
																numberOfLines={1}
															>
																{bucket.name}
															</Text>
														</View>
													) : null}
													{bucket && t.due_at ? (
														<Text style={[s.meta, s.metaSep]}>·</Text>
													) : null}
													{t.due_at ? (
														<Text
															style={[
																s.meta,
																overdueDue ? s.dueOverdue : s.due,
															]}
														>
															due <TimeAgo value={t.due_at} />
														</Text>
													) : null}
													{hasAlerts(t) ? (
														<Ionicons
															name="notifications-outline"
															size={12}
															color={colors.accent}
															style={s.alertIcon}
														/>
													) : null}
												</View>
												{tagsOf.length ? (
													<View style={s.tagsRight}>
														{tagsOf.map((tag) => (
															<Pressable
																key={tag}
																hitSlop={4}
																onPress={() => selectTag(tag)}
															>
																<Text
																	style={[s.meta, { color: tagColorOf(tag) }]}
																>
																	#{tag}
																</Text>
															</Pressable>
														))}
													</View>
												) : null}
											</View>
										) : null}
									</Pressable>
									{/* Grab handle — only the dateless TO DO group reorders. */}
									{canDrag ? (
										<Pressable
											onLongPress={drag}
											delayLongPress={200}
											hitSlop={8}
										>
											<Ionicons
												name="reorder-three"
												size={20}
												color={colors.muted}
											/>
										</Pressable>
									) : null}
								</View>
							</ScaleDecorator>
						);
					}}
				/>
			)}

			{taskSheet ? (
				<TaskSheet
					task={taskSheet.task}
					defaultTags={taskSheet.defaultTags}
					defaultBucket={taskSheet.defaultBucket}
					newRank={taskSheet.newRank}
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

function Chip({ label, count, active, color, swatch, onPress }) {
	return (
		<Pressable
			style={[s.chip, active && s.chipOn]}
			onPress={onPress}
			hitSlop={6}
		>
			{/* Buckets get a filled colour square (hollow = "no bucket"); tags carry
			   their colour on the label text instead. */}
			{swatch ? (
				<View
					style={[
						s.chipSwatch,
						color ? { backgroundColor: color, borderColor: color } : null,
					]}
				/>
			) : null}
			<Text
				style={[
					s.chipText,
					swatch && s.chipTextBucket,
					active && s.chipTextOn,
					!swatch && color ? { color } : null,
				]}
			>
				{label}
			</Text>
			<Text style={[s.chipCount, active && s.chipTextOn]}>{count}</Text>
		</Pressable>
	);
}

// ── Create-task sheet ──────────────────────────────────────────────────────

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
	const { data: buckets = [] } = useBuckets();
	const [title, setTitle] = useState(task?.title ?? "");
	const [dueAt, setDueAt] = useState(task?.due_at ?? null);
	const [priority, setPriority] = useState(task?.priority ?? 0);
	const [bucketId, setBucketId] = useState(
		task?.bucket_id ?? defaultBucket ?? null,
	);
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
			bucket_id: bucketId || null,
			tags,
			alerts,
		};
		if (editing) {
			updateTask.mutate({ id: task.id, ...payload }, { onSuccess: onClose });
		} else {
			createTask.mutate({ ...payload, rank: newRank }, { onSuccess: onClose });
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
	const bucketName = buckets.find((b) => b.id === bucketId)?.name;
	const detailSummary =
		[
			dueAt ? "due set" : null,
			priority ? PRIORITY[priority] : null,
			bucketName || null,
			tagCount ? `${tagCount} tag${tagCount > 1 ? "s" : ""}` : null,
			alerts.length
				? `${alerts.length} alert${alerts.length > 1 ? "s" : ""}`
				: null,
		]
			.filter(Boolean)
			.join(" · ") || "due, priority, bucket, tags, alerts";

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
					<Text style={s.label}>Bucket</Text>
					<View style={s.prioRow}>
						<Pressable
							style={[s.prioBtn, !bucketId && s.prioBtnOn]}
							onPress={() => setBucketId(null)}
						>
							<Text style={[s.prioBtnText, !bucketId && s.prioBtnTextOn]}>
								none
							</Text>
						</Pressable>
						{buckets.map((b) => (
							<Pressable
								key={b.id}
								style={[s.prioBtn, bucketId === b.id && s.prioBtnOn]}
								onPress={() => setBucketId(b.id)}
							>
								<Text
									style={[s.prioBtnText, bucketId === b.id && s.prioBtnTextOn]}
								>
									{b.name}
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
	const { data: buckets = [] } = useBuckets();
	const [title, setTitle] = useState("");
	const [freq, setFreq] = useState("WEEKLY");
	const [byday, setByday] = useState(["MO", "WE", "FR"]);
	const [dtstart, setDtstart] = useState(null);
	const [bucketId, setBucketId] = useState(null);
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
				bucket_id: bucketId || null,
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
				<Text style={s.label}>Bucket</Text>
				<View style={s.prioRow}>
					<Pressable
						style={[s.prioBtn, !bucketId && s.prioBtnOn]}
						onPress={() => setBucketId(null)}
					>
						<Text style={[s.prioBtnText, !bucketId && s.prioBtnTextOn]}>
							none
						</Text>
					</Pressable>
					{buckets.map((b) => (
						<Pressable
							key={b.id}
							style={[s.prioBtn, bucketId === b.id && s.prioBtnOn]}
							onPress={() => setBucketId(b.id)}
						>
							<Text
								style={[s.prioBtnText, bucketId === b.id && s.prioBtnTextOn]}
							>
								{b.name}
							</Text>
						</Pressable>
					))}
				</View>
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
	// Icon-only chip that reveals the tag-search field.
	searchChip: {
		justifyContent: "center",
		alignItems: "center",
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 9,
		paddingVertical: 6,
	},
	chipText: { color: colors.text, fontFamily: MONO, fontSize: 12 },
	// Bucket label reads as a heading (colour lives in the swatch).
	chipTextBucket: {
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 0.4,
	},
	// Filled square = bucket colour; hollow (border only) = "no bucket".
	chipSwatch: {
		width: 10,
		height: 10,
		borderRadius: 2,
		borderWidth: 1,
		borderColor: colors.muted,
		backgroundColor: "transparent",
	},
	chipTextOn: { color: colors.accent2 },
	chipCount: { color: colors.muted, fontFamily: MONO, fontSize: 11 },
	// The dragger's outer container must fill the space left under the header +
	// chip bar so its FlatList scrolls within bounds (see usage comment).
	listContainer: { flex: 1 },
	listFlex: { flex: 1 },
	scroll: { padding: 16, paddingBottom: 48 },
	// Footer button revealing the next page of completed tasks.
	loadMore: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		paddingVertical: 12,
		marginTop: 2,
	},
	loadMoreText: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 12,
		letterSpacing: 0.5,
	},
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
	// Active bucket/tag filter shown above the groups.
	filterHeading: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
		letterSpacing: 0.5,
		marginTop: 4,
		marginBottom: 2,
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
		// Thicker left edge carries the task's priority colour (see PRIORITY_*).
		borderLeftWidth: 3,
		// Square edges = pixel.
		paddingHorizontal: 10,
		paddingVertical: 9,
		marginBottom: 6,
	},
	// Row lifted while being dragged.
	taskRowActive: {
		borderColor: colors.accent2,
		backgroundColor: colors.bg,
		shadowColor: "#000",
		shadowOpacity: 0.4,
		shadowRadius: 8,
		shadowOffset: { width: 0, height: 4 },
		elevation: 6,
	},
	dim: { opacity: 0.55 },
	check: { color: colors.accent2, fontFamily: MONO, fontSize: 18 },
	// Match the ☐ glyph footprint so swapping in the spinner doesn't shift the row.
	checkSpin: { width: 18, height: 18 },
	taskMain: { flex: 1 },
	taskTitle: { color: colors.text, fontFamily: MONO, fontSize: 14 },
	strike: { textDecorationLine: "line-through", flex: 1 },
	// Meta line: bucket+due cluster on the left, tags right-aligned.
	metaRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 8,
		marginTop: 4,
	},
	metaLeft: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		flexShrink: 1,
		minWidth: 0,
	},
	tagsRight: {
		flex: 1,
		flexDirection: "row",
		flexWrap: "wrap",
		justifyContent: "flex-end",
		gap: 8,
	},
	meta: { fontFamily: MONO, fontSize: 11, letterSpacing: 0.3 },
	due: { color: colors.accent },
	// Overdue due-date text reads in the alert colour.
	dueOverdue: { color: colors.accent3, fontWeight: "700" },
	// Bell shown when a task has one or more alerts configured.
	alertIcon: { marginLeft: 2 },
	tag: { color: colors.accent2 },
	rrule: { color: colors.accent4 },
	metaSep: { color: colors.muted },
	// Bucket on the meta line: a colour swatch + uppercase name (colour lives in
	// the swatch), matching the filter chips / web sidebar.
	bucketTag: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		flexShrink: 1,
		minWidth: 0,
	},
	bucketSwatch: {
		width: 8,
		height: 8,
		borderRadius: 2,
		borderWidth: 1,
		borderColor: colors.muted,
		backgroundColor: "transparent",
	},
	bucketName: {
		color: colors.muted,
		textTransform: "uppercase",
		letterSpacing: 0.5,
		flexShrink: 1,
	},
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
