import { FlexWidget, ListWidget } from "react-native-android-widget";
import { colors } from "../utils/theme";
import { DEEP_LINK_CALENDAR } from "./constants";
import { eventWhenLabel } from "./format";
import { EmptyState, FRAME_STYLE, Header, OverflowRow, Row } from "./shared";

const MAX_ROWS = 8;

// Renders the Calendar widget. `summary` is the /widgets/summary payload (or
// null when logged out / never fetched). Whole-widget tap opens the Calendar.
export function CalendarWidget({ summary }) {
	const events = summary?.events ?? [];
	const rows = events.slice(0, MAX_ROWS);
	const overflow = events.length - rows.length;

	return (
		<FlexWidget
			clickAction="OPEN_URI"
			clickActionData={{ uri: DEEP_LINK_CALENDAR }}
			style={FRAME_STYLE}
		>
			<Header title="Calendar" count={events.length} tint={colors.accent2} />
			{rows.length === 0 ? (
				<EmptyState
					text={summary ? "No upcoming events" : "Open the app to sign in"}
				/>
			) : (
				<ListWidget style={{ flex: 1, width: "match_parent" }}>
					{rows.map((event) => (
						<Row
							key={event.id}
							uri={`${DEEP_LINK_CALENDAR}?id=${event.id}`}
							dotColor={colors.accent2}
							title={event.title}
							titleColor={colors.text}
							when={eventWhenLabel(event)}
						/>
					))}
					<OverflowRow count={overflow} />
				</ListWidget>
			)}
		</FlexWidget>
	);
}
