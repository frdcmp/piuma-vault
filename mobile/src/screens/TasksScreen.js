import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import BottomSheet from "../components/BottomSheet";
import DateTimePickerField from "../components/DateTimePickerField";
import {
	useCreateRecurringTask,
	useCreateTask,
	useDeleteRecurringTask,
	useDeleteTask,
	useRecurringTasks,
	useTasks,
	useToggleTask,
} from "../queries/tasksQuery";
import { formatDate, timeAgo } from "../utils/dateTime";
import { colors, mono as MONO } from "../utils/theme";

const PRIORITY = ["none", "low", "med", "high"];
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

export default function TasksScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const { data: tasks = [] } = useTasks();
	const { data: recurring = [] } = useRecurringTasks();
	const toggleTask = useToggleTask();
	const deleteTask = useDeleteTask();
	const deleteRecurring = useDeleteRecurringTask();

	const [taskSheet, setTaskSheet] = useState(false);
	const [recSheet, setRecSheet] = useState(false);

	const oneOff = tasks.filter((t) => !t.recurrence_id);
	const pending = oneOff.filter((t) => !t.done);
	const done = oneOff.filter((t) => t.done);

	return (
		<View style={[s.root, { paddingTop: insets.top }]}>
			<View style={s.header}>
				<Pressable onPress={() => navigation.goBack()} hitSlop={10}>
					<Ionicons name="chevron-back" size={22} color={colors.text} />
				</Pressable>
				<Text style={s.title}>☑ Tasks</Text>
				<Pressable onPress={() => setTaskSheet(true)} hitSlop={10}>
					<Ionicons name="add" size={24} color={colors.accent} />
				</Pressable>
			</View>

			<ScrollView contentContainerStyle={s.scroll}>
				<Text style={s.section}>TO DO · {pending.length}</Text>
				{pending.length === 0 ? (
					<Text style={s.empty}>Nothing to do. Piuma approves.</Text>
				) : null}
				{pending.map((t) => (
					<View key={t.id} style={s.taskRow}>
						<Pressable onPress={() => toggleTask.mutate(t.id)} hitSlop={8}>
							<Text style={s.check}>☐</Text>
						</Pressable>
						<View style={s.taskMain}>
							<Text style={s.taskTitle}>{t.title}</Text>
							<View style={s.metaRow}>
								{t.priority ? (
									<Text style={[s.meta, s.prio]}>{PRIORITY[t.priority]}</Text>
								) : null}
								{t.due_at ? (
									<Text style={[s.meta, s.due]}>due {timeAgo(t.due_at)}</Text>
								) : null}
								{(t.tags || []).map((tag) => (
									<Text key={tag} style={[s.meta, s.tag]}>
										#{tag}
									</Text>
								))}
							</View>
						</View>
						<Pressable onPress={() => deleteTask.mutate(t.id)} hitSlop={8}>
							<Ionicons name="close" size={16} color={colors.muted} />
						</Pressable>
					</View>
				))}

				{done.length > 0 ? (
					<>
						<Text style={s.section}>DONE · {done.length}</Text>
						{done.map((t) => (
							<View key={t.id} style={[s.taskRow, s.dim]}>
								<Pressable onPress={() => toggleTask.mutate(t.id)} hitSlop={8}>
									<Text style={s.check}>☑</Text>
								</Pressable>
								<Text style={[s.taskTitle, s.strike]}>{t.title}</Text>
								<Pressable onPress={() => deleteTask.mutate(t.id)} hitSlop={8}>
									<Ionicons name="close" size={16} color={colors.muted} />
								</Pressable>
							</View>
						))}
					</>
				) : null}

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
								{!r.active ? <Text style={[s.meta, s.tag]}>paused</Text> : null}
							</View>
						</View>
						<Pressable onPress={() => deleteRecurring.mutate(r.id)} hitSlop={8}>
							<Ionicons name="close" size={16} color={colors.muted} />
						</Pressable>
					</View>
				))}
			</ScrollView>

			{taskSheet ? <TaskSheet onClose={() => setTaskSheet(false)} /> : null}
			{recSheet ? <RecurringSheet onClose={() => setRecSheet(false)} /> : null}
		</View>
	);
}

// ── Create-task sheet ──────────────────────────────────────────────────────

function TaskSheet({ onClose }) {
	const createTask = useCreateTask();
	const [title, setTitle] = useState("");
	const [dueAt, setDueAt] = useState(null);
	const [priority, setPriority] = useState(0);
	const [tags, setTags] = useState("");

	const save = () => {
		if (!title.trim()) return;
		createTask.mutate(
			{
				title: title.trim(),
				due_at: dueAt || null,
				priority,
				tags: tags
					.split(",")
					.map((x) => x.trim().toLowerCase())
					.filter(Boolean),
			},
			{ onSuccess: onClose },
		);
	};

	return (
		<BottomSheet visible onClose={onClose} title="New task">
			<View style={s.form}>
				<Text style={s.label}>Title</Text>
				<TextInput
					style={s.input}
					value={title}
					onChangeText={setTitle}
					placeholder="What needs doing?"
					placeholderTextColor={colors.muted}
				/>
				<Text style={s.label}>Due</Text>
				<DateTimePickerField
					value={dueAt}
					onChange={setDueAt}
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
							<Text style={[s.prioBtnText, priority === i && s.prioBtnTextOn]}>
								{p}
							</Text>
						</Pressable>
					))}
				</View>
				<Text style={s.label}>Tags</Text>
				<TextInput
					style={s.input}
					value={tags}
					onChangeText={setTags}
					placeholder="fitness, admin"
					placeholderTextColor={colors.muted}
					autoCapitalize="none"
				/>
				<Pressable style={s.saveBtn} onPress={save}>
					<Text style={s.saveBtnText}>Save</Text>
				</Pressable>
			</View>
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
	const [tags, setTags] = useState("");

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
				tags: tags
					.split(",")
					.map((x) => x.trim().toLowerCase())
					.filter(Boolean),
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
				<TextInput
					style={s.input}
					value={tags}
					onChangeText={setTags}
					placeholder="fitness"
					placeholderTextColor={colors.muted}
					autoCapitalize="none"
				/>
				<Text style={s.hint}>rule: {buildRrule(freq, byday)}</Text>
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
	title: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 16,
		fontWeight: "700",
		letterSpacing: 1,
	},
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
	form: { paddingHorizontal: 16, paddingTop: 4, gap: 6 },
	label: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
		marginTop: 8,
	},
	input: {
		backgroundColor: colors.bg,
		borderWidth: 1,
		borderColor: colors.border,
		color: colors.text,
		fontFamily: MONO,
		paddingHorizontal: 10,
		paddingVertical: 9,
		fontSize: 14,
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
		paddingVertical: 11,
		alignItems: "center",
		marginTop: 16,
	},
	saveBtnText: {
		color: "#000",
		fontFamily: MONO,
		fontWeight: "700",
		fontSize: 14,
		letterSpacing: 1.5,
		textTransform: "uppercase",
	},
});
