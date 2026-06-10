import { CalendarWidget } from "./CalendarWidget";
import { WIDGET_CALENDAR, WIDGET_TASKS } from "./constants";
import { TasksWidget } from "./TasksWidget";
import { fetchWidgetSummary } from "./widgetData";

const WIDGETS = {
	[WIDGET_TASKS]: TasksWidget,
	[WIDGET_CALENDAR]: CalendarWidget,
};

// Entry point the native side calls (registered in index.js) for every widget
// lifecycle action. We render the matching widget; clicks are handled natively
// via OPEN_URI deep links, so WIDGET_CLICK needs no work here.
export async function widgetTaskHandler(props) {
	const { widgetName } = props.widgetInfo;
	const Widget = WIDGETS[widgetName];
	if (!Widget) return;

	switch (props.widgetAction) {
		case "WIDGET_ADDED":
		case "WIDGET_UPDATE":
		case "WIDGET_RESIZED": {
			// Fetch fresh; falls back to the cached payload on any failure so the
			// widget paints something rather than going blank.
			const summary = await fetchWidgetSummary();
			props.renderWidget(<Widget summary={summary} />);
			break;
		}
		default:
			break;
	}
}
