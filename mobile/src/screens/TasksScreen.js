import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Dimensions,
	Platform,
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
import AlertsField, { formatOffset } from "../components/AlertsField";
import BottomSheet from "../components/BottomSheet";
import ConfirmModal from "../components/ConfirmModal";
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

// Cap the task sheet's scrollable body so an expanded editor never pushes it
// off the top of the screen — it scrolls within this height instead.
const SHEET_MAX = Math.round(Dimensions.get("window").height * 0.68);

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
	// Scrollable detail body: capped so an expanded editor scrolls instead of
	// shoving the sheet off-screen.
	sheetScroll: { maxHeight: SHEET_MAX },
	// Header: checkbox + bucket tag (left) + priority flag (right).
	headerRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 10,
		marginBottom: 10,
	},
	headerLeft: {
		flexDirection: "row",
		alignItems: "center",
		gap: 9,
		flexShrink: 1,
		minWidth: 0,
	},
	headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
	headerCheck: { fontFamily: MONO, fontSize: 22, lineHeight: 24 },
	// Match the ☐ glyph footprint so the spinner doesn't shift the row.
	headerCheckSpin: { width: 22, height: 24 },
	bucketChip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
		flexShrink: 1,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 10,
		paddingVertical: 6,
	},
	flagBtn: { padding: 4 },
	// Priority popover anchored under the header flag.
	overlay: { ...StyleSheet.absoluteFillObject },
	menuBackdrop: { ...StyleSheet.absoluteFillObject },
	prioMenu: {
		// Drops from just under the header flag (header sits below the ~33px grab
		// zone; the flag is the top-right of the first row).
		position: "absolute",
		top: 56,
		right: 0,
		minWidth: 130,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.borderStrong,
		paddingVertical: 2,
		elevation: 8,
		shadowColor: "#000",
		shadowOpacity: 0.4,
		shadowRadius: 8,
		shadowOffset: { width: 0, height: 3 },
	},
	prioMenuItem: {
		flexDirection: "row",
		alignItems: "center",
		gap: 9,
		paddingHorizontal: 12,
		paddingVertical: 9,
	},
	prioMenuText: {
		flex: 1,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 13,
		letterSpacing: 0.5,
		textTransform: "uppercase",
	},
	prioMenuTextOn: { color: colors.accent2, fontWeight: "700" },
	bucketChipText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
		letterSpacing: 0.4,
		textTransform: "uppercase",
		flexShrink: 1,
	},
	// A row in the bucket picker sheet.
	bucketOpt: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 12,
		borderTopWidth: 1,
		borderTopColor: colors.border,
	},
	bucketOptFirst: { borderTopWidth: 0 },
	bucketOptText: {
		flex: 1,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		letterSpacing: 0.3,
	},
	titleDone: { color: colors.muted, textDecorationLine: "line-through" },
	// Borderless description below the title (TickTick-style plain notes).
	notesInput: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 13,
		lineHeight: 19,
		minHeight: 36,
		paddingTop: 4,
		paddingBottom: 4,
	},
	// Borderless like the notes, but bigger + bold so it reads as the title.
	titleInput: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 19,
		lineHeight: 26,
		fontWeight: "700",
		minHeight: 38,
		paddingTop: 2,
		paddingBottom: 2,
	},
	// TickTick-style attribute row + inline accordion editor.
	attr: { borderTopWidth: 1, borderTopColor: colors.border },
	attrFlush: { borderTopWidth: 0 },
	attrHead: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 12,
	},
	attrLabel: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 13,
		fontWeight: "700",
		letterSpacing: 0.5,
	},
	attrValWrap: {
		flex: 1,
		flexDirection: "row",
		justifyContent: "flex-end",
	},
	attrVal: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 13,
		flexShrink: 1,
		textAlign: "right",
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
});
