import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useBuckets } from "../../queries/tagsQuery";
import { useCreateRecurringTask } from "../../queries/tasksQuery";
import { colors } from "../../utils/theme";
import AlertsField from "../AlertsField";
import BottomSheet from "../BottomSheet";
import DateTimePickerField from "../DateTimePickerField";
import TagPicker from "../TagPicker";
import { buildRrule, DOW, DOW_LABEL } from "./taskConstants";
import { s } from "./taskStyles";

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

export default RecurringSheet;
