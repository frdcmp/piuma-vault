import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ConfirmModal from "../components/ConfirmModal";
import { toast } from "../components/Toast";
import {
	useCreateCronJob,
	useCronJobs,
	useDeleteCronJob,
	useRunCronJobNow,
	useToggleCronJob,
} from "../queries/cronQuery";
import { formatDateTime, timeAgo } from "../utils/dateTime";
import { colors, mono } from "../utils/theme";

const browserTz = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const PRESETS = [
	{ k: "daily", l: "Daily" },
	{ k: "weekdays", l: "Weekdays" },
	{ k: "weekly", l: "Weekly" },
	{ k: "once", l: "Once" },
];

const dtstartFromTime = (hhmm) => {
	const [h, m] = (hhmm || "08:00")
		.split(":")
		.map((n) => Number.parseInt(n, 10));
	const d = new Date();
	d.setHours(h || 0, m || 0, 0, 0);
	return d.toISOString();
};

const scheduleLabel = (job) => {
	if (job.schedule_kind === "once") {
		const f = formatDateTime(job.run_at);
		return `Once · ${f.date} ${f.time}`;
	}
	const t = formatDateTime(job.dtstart).time;
	if (job.rrule?.includes("WEEKLY")) {
		const m = job.rrule.match(/BYDAY=([A-Z,]+)/);
		const list = m ? m[1].split(",") : [];
		if (
			list.length === 5 &&
			["MO", "TU", "WE", "TH", "FR"].every((k) => list.includes(k))
		)
			return `Weekdays · ${t}`;
		return `Weekly ${list.join(", ")} · ${t}`;
	}
	return `Daily · ${t}`;
};

const blankForm = {
	title: "",
	prompt: "",
	preset: "daily",
	time: "08:00",
	days: ["MO"],
	runAt: "",
	allowDestructive: false,
};

export default function CronScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const { data: jobs = [] } = useCronJobs();
	const createJob = useCreateCronJob();
	const deleteJob = useDeleteCronJob();
	const runNow = useRunCronJobNow();
	const toggleJob = useToggleCronJob();

	const [form, setForm] = useState(null); // null | blankForm
	const [pendingDelete, setPendingDelete] = useState(null);

	const toggleDay = (k) =>
		setForm((f) => ({
			...f,
			days: f.days.includes(k) ? f.days.filter((d) => d !== k) : [...f.days, k],
		}));

	const save = async () => {
		if (!form.title.trim() || !form.prompt.trim()) {
			toast.error("Title and prompt are required");
			return;
		}
		const base = {
			title: form.title.trim(),
			prompt: form.prompt.trim(),
			timezone: browserTz(),
			notify: true,
			notify_channels: ["web", "push"],
			allow_destructive: form.allowDestructive,
		};
		let payload;
		if (form.preset === "once") {
			if (!form.runAt) {
				toast.error("Enter a date & time (YYYY-MM-DD HH:MM)");
				return;
			}
			payload = {
				...base,
				schedule_kind: "once",
				run_at: new Date(form.runAt.replace(" ", "T")).toISOString(),
			};
		} else {
			let rrule = "FREQ=DAILY";
			if (form.preset === "weekdays")
				rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
			else if (form.preset === "weekly")
				rrule = `FREQ=WEEKLY;BYDAY=${(form.days.length ? form.days : ["MO"]).join(",")}`;
			payload = {
				...base,
				schedule_kind: "recurring",
				rrule,
				dtstart: dtstartFromTime(form.time),
			};
		}
		try {
			await createJob.mutateAsync(payload);
			toast.success("Scheduled job created");
			setForm(null);
		} catch (e) {
			toast.error(e?.response?.data?.error || "Couldn't create job");
		}
	};

	return (
		<View style={styles.root}>
			<View style={[styles.bar, { paddingTop: insets.top + 12 }]}>
				<Pressable onPress={() => navigation.goBack()} hitSlop={10}>
					<Ionicons name="chevron-back" size={22} color={colors.text} />
				</Pressable>
				<Text style={styles.title}>Scheduled</Text>
				<Pressable onPress={() => setForm({ ...blankForm })} hitSlop={10}>
					<Ionicons name="add" size={24} color={colors.accent2} />
				</Pressable>
			</View>

			<ScrollView
				contentContainerStyle={{
					padding: 16,
					paddingBottom: insets.bottom + 32,
				}}
			>
				{jobs.length === 0 ? (
					<Text style={styles.empty}>
						No scheduled jobs yet. Tap + to add one.
					</Text>
				) : (
					jobs.map((job) => (
						<View key={job.id} style={styles.job}>
							<Pressable
								onPress={() => toggleJob.mutate(job.id)}
								hitSlop={8}
								style={styles.dot}
							>
								<Ionicons
									name={job.enabled ? "ellipse" : "ellipse-outline"}
									size={14}
									color={job.enabled ? colors.accent2 : colors.muted}
								/>
							</Pressable>
							<View style={{ flex: 1, minWidth: 0 }}>
								<Text style={styles.jobName} numberOfLines={1}>
									{job.title}
								</Text>
								<Text style={styles.jobSched} numberOfLines={1}>
									{scheduleLabel(job)}
									{job.enabled && job.next_run_at
										? ` · next ${timeAgo(job.next_run_at)}`
										: " · paused"}
								</Text>
							</View>
							<Pressable
								onPress={() => {
									runNow.mutate(job.id);
									toast.success("Queued to run now");
								}}
								hitSlop={8}
								style={styles.act}
							>
								<Ionicons name="play" size={16} color={colors.accent} />
							</Pressable>
							<Pressable
								onPress={() => setPendingDelete(job)}
								hitSlop={8}
								style={styles.act}
							>
								<Ionicons
									name="trash-outline"
									size={16}
									color={colors.accent3}
								/>
							</Pressable>
						</View>
					))
				)}
			</ScrollView>

			{/* Create form */}
			<Modal
				visible={!!form}
				transparent
				animationType="slide"
				onRequestClose={() => setForm(null)}
			>
				<View style={styles.scrim}>
					<View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
						<ScrollView>
							<Text style={styles.sheetTitle}>New scheduled job</Text>
							<TextInput
								style={styles.input}
								placeholder="Title"
								placeholderTextColor={colors.muted}
								value={form?.title}
								onChangeText={(v) => setForm((f) => ({ ...f, title: v }))}
							/>
							<TextInput
								style={[styles.input, styles.textarea]}
								placeholder="What should the agent do?"
								placeholderTextColor={colors.muted}
								multiline
								value={form?.prompt}
								onChangeText={(v) => setForm((f) => ({ ...f, prompt: v }))}
							/>
							<View style={styles.row}>
								{PRESETS.map((p) => (
									<Pressable
										key={p.k}
										onPress={() => setForm((f) => ({ ...f, preset: p.k }))}
										style={[styles.chip, form?.preset === p.k && styles.chipOn]}
									>
										<Text
											style={[
												styles.chipTxt,
												form?.preset === p.k && styles.chipTxtOn,
											]}
										>
											{p.l}
										</Text>
									</Pressable>
								))}
							</View>
							{form?.preset === "weekly" && (
								<View style={styles.row}>
									{WEEKDAYS.map((d) => (
										<Pressable
											key={d}
											onPress={() => toggleDay(d)}
											style={[
												styles.chip,
												form?.days.includes(d) && styles.chipOn,
											]}
										>
											<Text
												style={[
													styles.chipTxt,
													form?.days.includes(d) && styles.chipTxtOn,
												]}
											>
												{d}
											</Text>
										</Pressable>
									))}
								</View>
							)}
							{form?.preset === "once" ? (
								<TextInput
									style={styles.input}
									placeholder="YYYY-MM-DD HH:MM"
									placeholderTextColor={colors.muted}
									value={form?.runAt}
									onChangeText={(v) => setForm((f) => ({ ...f, runAt: v }))}
								/>
							) : (
								<TextInput
									style={styles.input}
									placeholder="Time (HH:MM)"
									placeholderTextColor={colors.muted}
									value={form?.time}
									onChangeText={(v) => setForm((f) => ({ ...f, time: v }))}
								/>
							)}
							<Pressable
								onPress={() =>
									setForm((f) => ({
										...f,
										allowDestructive: !f.allowDestructive,
									}))
								}
								style={styles.checkRow}
							>
								<Ionicons
									name={form?.allowDestructive ? "checkbox" : "square-outline"}
									size={18}
									color={form?.allowDestructive ? colors.accent2 : colors.muted}
								/>
								<Text style={styles.checkLabel}>
									Allow destructive tools (delete)
								</Text>
							</Pressable>

							<View style={styles.sheetActions}>
								<Pressable
									onPress={() => setForm(null)}
									style={styles.btnGhost}
								>
									<Text style={styles.btnGhostTxt}>Cancel</Text>
								</Pressable>
								<Pressable onPress={save} style={styles.btnPrimary}>
									<Text style={styles.btnPrimaryTxt}>Create</Text>
								</Pressable>
							</View>
						</ScrollView>
					</View>
				</View>
			</Modal>

			<ConfirmModal
				visible={!!pendingDelete}
				title="Delete scheduled job"
				message={`Delete "${pendingDelete?.title}"? Its run history is removed too.`}
				confirmText="Delete"
				danger
				onConfirm={() => {
					deleteJob.mutate(pendingDelete.id);
					setPendingDelete(null);
				}}
				onCancel={() => setPendingDelete(null)}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#0b0c10" },
	bar: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.borderStrong,
	},
	title: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 16,
		fontWeight: "700",
	},
	empty: {
		color: colors.muted,
		fontFamily: mono,
		textAlign: "center",
		marginTop: 48,
	},
	job: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 10,
		borderBottomWidth: 1,
		borderBottomColor: "#1f242c",
	},
	dot: { padding: 2 },
	jobName: { color: colors.text, fontFamily: mono, fontSize: 14 },
	jobSched: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 11,
		marginTop: 2,
	},
	act: { padding: 4 },
	scrim: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		justifyContent: "flex-end",
	},
	sheet: {
		backgroundColor: colors.panel,
		borderTopWidth: 2,
		borderTopColor: colors.accent2,
		padding: 16,
		maxHeight: "88%",
	},
	sheetTitle: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 15,
		fontWeight: "700",
		marginBottom: 12,
	},
	input: {
		backgroundColor: colors.bg,
		borderWidth: 1,
		borderColor: colors.borderStrong,
		color: colors.text,
		fontFamily: mono,
		fontSize: 14,
		padding: 10,
		marginBottom: 10,
	},
	textarea: { minHeight: 70, textAlignVertical: "top" },
	row: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 },
	chip: {
		paddingHorizontal: 10,
		paddingVertical: 5,
		borderWidth: 1,
		borderColor: colors.borderStrong,
	},
	chipOn: {
		borderColor: colors.accent2,
		backgroundColor: "rgba(92,208,169,0.1)",
	},
	chipTxt: { color: colors.muted, fontFamily: mono, fontSize: 12 },
	chipTxtOn: { color: colors.accent2 },
	checkRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 14,
	},
	checkLabel: { color: colors.muted, fontFamily: mono, fontSize: 12 },
	sheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
	btnGhost: {
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderWidth: 1,
		borderColor: colors.borderStrong,
	},
	btnGhostTxt: { color: colors.muted, fontFamily: mono, fontSize: 13 },
	btnPrimary: {
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderWidth: 2,
		borderColor: colors.accent2,
	},
	btnPrimaryTxt: {
		color: colors.accent2,
		fontFamily: mono,
		fontSize: 13,
		fontWeight: "700",
	},
});
