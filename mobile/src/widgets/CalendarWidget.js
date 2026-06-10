import {
	FlexWidget,
	ListWidget,
	TextWidget,
} from "react-native-android-widget";
import { colors } from "../utils/theme";
import { DEEP_LINK_CALENDAR } from "./constants";
import { eventWhenLabel } from "./format";

const MAX_ROWS = 8;

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
				text="Calendar"
				style={{ fontSize: 15, fontWeight: "700", color: colors.text }}
			/>
			<TextWidget
				text={count > 0 ? String(count) : ""}
				style={{ fontSize: 13, fontWeight: "600", color: colors.accent2 }}
			/>
		</FlexWidget>
	);
}

function EventRow({ event }) {
	return (
		<FlexWidget
			clickAction="OPEN_URI"
			clickActionData={{ uri: `${DEEP_LINK_CALENDAR}?id=${event.id}` }}
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
					backgroundColor: colors.accent2,
				}}
			/>
			<FlexWidget style={{ flex: 1, flexDirection: "column" }}>
				<TextWidget
					text={event.title}
					maxLines={1}
					truncate="END"
					style={{ fontSize: 13, color: colors.text }}
				/>
			</FlexWidget>
			<TextWidget
				text={eventWhenLabel(event)}
				maxLines={1}
				style={{ fontSize: 11, color: colors.muted, marginLeft: 8 }}
			/>
		</FlexWidget>
	);
}

// Renders the Calendar widget. Whole-widget tap opens the Calendar screen.
export function CalendarWidget({ summary }) {
	const events = summary?.events ?? [];
	const rows = events.slice(0, MAX_ROWS);
	const overflow = events.length - rows.length;

	return (
		<FlexWidget
			clickAction="OPEN_URI"
			clickActionData={{ uri: DEEP_LINK_CALENDAR }}
			style={rootStyle}
		>
			<Header count={events.length} />
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
						text={summary ? "No upcoming events" : "Open the app to sign in"}
						style={{ fontSize: 13, color: colors.muted }}
					/>
				</FlexWidget>
			) : (
				<ListWidget style={{ flex: 1, width: "match_parent" }}>
					{rows.map((event) => (
						<EventRow key={event.id} event={event} />
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
