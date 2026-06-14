import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import DraggableFlatList, {
	ScaleDecorator,
} from "react-native-draggable-flatlist";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ManageBucketsSheet from "../components/ManageBucketsSheet";
import ScreenHeader from "../components/ScreenHeader";
import SpriteLoader from "../components/SpriteLoader";
import TimeAgo from "../components/TimeAgo";
import Chip from "../components/tasks/FilterChip";
import RecurringSheet from "../components/tasks/RecurringSheet";
import { TaskSheet } from "../components/tasks/TaskSheet";
import {
	hasAlerts,
	PRIORITY_COLOR,
	PRIORITY_TINT,
} from "../components/tasks/taskConstants";
import { s } from "../components/tasks/taskStyles";
import {
	useBuckets,
	useTagRegistry,
	useTagsLiveUpdates,
} from "../queries/tagsQuery";
import {
	useDeleteRecurringTask,
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
import { colors } from "../utils/theme";

const ALL = { key: "all", names: null, label: "all" };

// Sentinel row that renders the "DONE · N" divider between the to-do and
// completed sections. Lives in the list data (not a footer) so the completed
// rows below it are virtualized and scroll/​paginate correctly.
const DONE_HEADER_ID = "__done_header__";

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
	// Re-sync from the server when the set OR the displayed CONTENT of the
	// pending tasks changes (add / remove / complete / filter switch / field
	// edit) — but NOT on a pure reorder, so an optimistic drag isn't clobbered by
	// the refetch it triggers. The signature is order-independent (sorted by id)
	// and hashes the fields a row renders, so editing e.g. a due date refreshes
	// the list while dragging (same ids + fields, new order) does not.
	const setSig = serverPending
		.map(
			(t) =>
				`${t.id}:${t.title}:${t.due_at}:${t.priority}:${t.bucket_id}:${(t.tags || []).join("|")}`,
		)
		.sort()
		.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-sync keyed on the content signature, not order
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
						<View
							key={r.id}
							style={[s.taskRow, s.taskRowInline, !r.active && s.dim]}
						>
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
								<View style={[s.taskRow, s.taskRowInline, s.dim]}>
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
						// by their due date, so dragging them is disabled. Drag starts on
						// a long-press anywhere on the card (no handle icon).
						const canDrag = !t.due_at;
						const overdueDue = dueBucket(t.due_at) === "overdue";
						return (
							<ScaleDecorator>
								<Pressable
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
									onPress={() => setTaskSheet({ task: t })}
									onLongPress={canDrag ? drag : undefined}
									delayLongPress={200}
								>
									{/* Top line: checkbox + bucket + due (+ alert bell), tags right. */}
									<View style={s.taskTop}>
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
													style={[
														s.check,
														{ color: PRIORITY_COLOR[t.priority] },
													]}
												>
													☐
												</Text>
											)}
										</Pressable>
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
													style={[s.meta, overdueDue ? s.dueOverdue : s.due]}
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
														<Text style={[s.meta, { color: tagColorOf(tag) }]}>
															#{tag}
														</Text>
													</Pressable>
												))}
											</View>
										) : null}
									</View>
									{/* Second line: the task title (priority shows via the left bar). */}
									<Text style={[s.taskTitle, s.taskTitleRow]} numberOfLines={2}>
										{t.title}
									</Text>
								</Pressable>
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
