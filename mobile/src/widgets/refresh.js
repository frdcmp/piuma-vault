import { requestWidgetUpdate } from "react-native-android-widget";
import { CalendarWidget } from "./CalendarWidget";
import { WIDGET_CALENDAR, WIDGET_TASKS } from "./constants";
import { TasksWidget } from "./TasksWidget";
import { fetchWidgetSummary } from "./widgetData";

// Push fresh data into every placed Tasks/Calendar widget. Fetches the summary
// once and reuses it for both. `requestWidgetUpdate` is a no-op (its
// `widgetNotFound` callback fires) when no widget of that name is on the home
// screen, so this is cheap to call liberally.
export async function refreshAllWidgets() {
	const summary = await fetchWidgetSummary();
	await Promise.all([
		requestWidgetUpdate({
			widgetName: WIDGET_TASKS,
			renderWidget: () => <TasksWidget summary={summary} />,
			widgetNotFound: () => {},
		}),
		requestWidgetUpdate({
			widgetName: WIDGET_CALENDAR,
			renderWidget: () => <CalendarWidget summary={summary} />,
			widgetNotFound: () => {},
		}),
	]);
}
