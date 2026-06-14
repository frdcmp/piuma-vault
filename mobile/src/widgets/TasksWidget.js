import { FlexWidget, ListWidget } from "react-native-android-widget";
import { colors } from "../utils/theme";
import { DEEP_LINK_TASKS } from "./constants";
import { taskWhenLabel } from "./format";
import { EmptyState, FRAME_STYLE, Header, OverflowRow, Row } from "./shared";

const MAX_ROWS = 8;

// Priority → dot color. Backend priority is 0..3 (0 none, 3 high).
function priorityColor(priority) {
	if (priority >= 3) return colors.accent3; // red
	if (priority === 2) return colors.accent; // yellow
	if (priority === 1) return colors.accent4; // blue
	return colors.muted;
}

// Renders the Tasks widget. `summary` is the /widgets/summary payload (or null
// when logged out / never fetched). Whole-widget tap opens the Tasks screen.
export function TasksWidget({ summary }) {
	const tasks = summary?.tasks ?? [];
	const rows = tasks.slice(0, MAX_ROWS);
	const overflow = tasks.length - rows.length;

	return (
		<FlexWidget
			clickAction="OPEN_URI"
			clickActionData={{ uri: DEEP_LINK_TASKS }}
			style={FRAME_STYLE}
		>
			<Header title="Tasks" count={tasks.length} tint={colors.accent} />
			{rows.length === 0 ? (
				<EmptyState
					text={summary ? "Nothing due" : "Open the app to sign in"}
				/>
			) : (
				<ListWidget style={{ flex: 1, width: "match_parent" }}>
					{rows.map((task) => (
						<Row
							key={`${task.id}-${task.occurrence_date ?? "once"}`}
							uri={`${DEEP_LINK_TASKS}?id=${task.id}`}
							dotColor={priorityColor(task.priority)}
							title={task.title}
							titleColor={task.overdue ? colors.accent3 : colors.text}
							when={taskWhenLabel(task)}
							whenColor={task.overdue ? colors.accent3 : colors.muted}
						/>
					))}
					<OverflowRow count={overflow} />
				</ListWidget>
			)}
		</FlexWidget>
	);
}
