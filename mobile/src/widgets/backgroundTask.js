import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { WIDGET_BG_TASK } from "./constants";
import { refreshAllWidgets } from "./refresh";

// Defined at module load (this module is required from index.js on Android) so
// the task exists before the OS ever invokes it headlessly.
TaskManager.defineTask(WIDGET_BG_TASK, async () => {
	try {
		await refreshAllWidgets();
		return BackgroundTask.BackgroundTaskResult.Success;
	} catch (e) {
		console.warn("[widget] background refresh failed", e);
		return BackgroundTask.BackgroundTaskResult.Failed;
	}
});

// Register the periodic refresh. The OS treats the interval as a minimum and
// batches wake-ups; 15 min is the practical floor on Android. Foreground/SSE
// refresh (useWidgetSync) covers the "feels live" gap between background runs.
export async function registerWidgetBackgroundTask() {
	try {
		const status = await BackgroundTask.getStatusAsync();
		if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return;
		const already = await TaskManager.isTaskRegisteredAsync(WIDGET_BG_TASK);
		if (!already) {
			await BackgroundTask.registerTaskAsync(WIDGET_BG_TASK, {
				minimumInterval: 15,
			});
		}
	} catch (e) {
		console.warn("[widget] background task register failed", e);
	}
}
