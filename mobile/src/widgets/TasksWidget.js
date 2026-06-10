import {
	FlexWidget,
	ListWidget,
	TextWidget,
} from "react-native-android-widget";
import { colors } from "../utils/theme";
import { DEEP_LINK_TASKS } from "./constants";
import { taskWhenLabel } from "./format";

const MAX_ROWS = 8;

// Priority → dot color. Backend priority is 0..3 (0 none, 3 high).
function priorityColor(priority) {
	if (priority >= 3) return colors.accent3; // red
	if (priority === 2) return colors.accent; // yellow
	if (priority === 1) return colors.accent4; // blue
	return colors.muted;
}

const rootStyle = {
	height: "match_parent",
	width: "match_parent",
	flexDirection: "column",
	backgroundColor: colors.bg,
	borderRadius: 16,
	padding: 12,
};

function Header({ count }) {
	return (
		<FlexWidget
			style={{
				flexDirection: "row",
				alignItems: "center",
				justifyContent: "space-between",
				width: "match_parent",
				marginBottom: 8,
			}}
		>
			<TextWidget
				text="Tasks"
				style={{ fontSize: 15, fontWeight: "700", color: colors.text }}
			/>
			<TextWidget
				text={count > 0 ? String(count) : ""}
				style={{ fontSize: 13, fontWeight: "600", color: colors.accent2 }}
			/>
		</FlexWidget>
	);
}

function TaskRow({ task }) {
	return (
		<FlexWidget
			clickAction="OPEN_URI"
			clickActionData={{ uri: `${DEEP_LINK_TASKS}?id=${task.id}` }}
			style={{
				flexDirection: "row",
				alignItems: "center",
				width: "match_parent",
				paddingVertical: 5,
			}}
		>
			<FlexWidget
				style={{
					height: 8,
					width: 8,
					borderRadius: 4,
					marginRight: 8,
					backgroundColor: priorityColor(task.priority),
				}}
			/>
			<FlexWidget style={{ flex: 1, flexDirection: "column" }}>
				<TextWidget
					text={task.title}
					maxLines={1}
					truncate="END"
					style={{
						fontSize: 13,
						color: task.overdue ? colors.accent3 : colors.text,
					}}
				/>
			</FlexWidget>
			<TextWidget
				text={taskWhenLabel(task)}
				maxLines={1}
				style={{ fontSize: 11, color: colors.muted, marginLeft: 8 }}
			/>
		</FlexWidget>
	);
}

// Renders the Tasks widget. `summary` is the /widgets/summary payload (or null
// when logged out / never fetched). Whole-widget tap opens the Tasks screen.
export function TasksWidget({ summary }) {
	const tasks = summary?.tasks ?? [];
	const rows = tasks.slice(0, MAX_ROWS);
	const overflow = tasks.length - rows.length;

	return (
		<FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: DEEP_LINK_TASKS }} style={rootStyle}>
			<Header count={tasks.length} />
			{rows.length === 0 ? (
				<FlexWidget
					style={{
						flex: 1,
						alignItems: "center",
						justifyContent: "center",
						width: "match_parent",
					}}
				>
					<TextWidget
						text={summary ? "Nothing due" : "Open the app to sign in"}
						style={{ fontSize: 13, color: colors.muted }}
					/>
				</FlexWidget>
			) : (
				<ListWidget style={{ flex: 1, width: "match_parent" }}>
					{rows.map((task) => (
						<TaskRow key={`${task.id}-${task.occurrence_date ?? "once"}`} task={task} />
					))}
					{overflow > 0 ? (
						<TextWidget
							text={`+${overflow} more`}
							style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}
						/>
					) : null}
				</ListWidget>
			)}
		</FlexWidget>
	);
}
