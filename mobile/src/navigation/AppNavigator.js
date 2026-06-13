import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import UpdatePrompt from "../components/UpdatePrompt";
import CalendarScreen from "../screens/CalendarScreen";
import CronScreen from "../screens/CronScreen";
import LoginScreen from "../screens/LoginScreen";
import RecorderScreen from "../screens/RecorderScreen";
import RecorderSessionsScreen from "../screens/RecorderSessionsScreen";
import RecordingDetailScreen from "../screens/RecordingDetailScreen";
import SettingsScreen from "../screens/SettingsScreen";
import SplashScreen from "../screens/SplashScreen";
import StorageScreen from "../screens/StorageScreen";
import MemoryScreen from "../screens/settings/MemoryScreen";
import ProfileScreen from "../screens/settings/ProfileScreen";
import SecurityScreen from "../screens/settings/SecurityScreen";
import SpritePickerScreen from "../screens/settings/SpritePickerScreen";
import TokenUsageScreen from "../screens/settings/TokenUsageScreen";
import TrashScreen from "../screens/settings/TrashScreen";
import TasksScreen from "../screens/TasksScreen";
import VaultHomeScreen from "../screens/VaultHomeScreen";
import { useAuthStore } from "../stores/authStore";
import { colors } from "../utils/theme";

// Minimum time the splash stays on screen — so users always get to see Piuma
// running, even if storage reads finish in a few ms.
const SPLASH_MIN_MS = 3000;

const Stack = createNativeStackNavigator();

// Deep links — used by the Android home-screen widgets to jump straight to a
// screen (e.g. piumavault://tasks?id=…). The `id` param is passed through to the
// screen for future per-item navigation; screens ignore it until then.
const linking = {
	prefixes: [Linking.createURL("/"), "piumavault://"],
	config: {
		screens: {
			VaultHome: "home",
			Calendar: "calendar",
			Tasks: "tasks",
			Storage: "storage",
			Recorder: "recorder",
		},
	},
};

const VaultTheme = {
	...DarkTheme,
	colors: {
		...DarkTheme.colors,
		primary: colors.accent,
		background: colors.bg,
		card: colors.panel,
		text: colors.text,
		border: colors.border,
		notification: colors.accent,
	},
};

export default function AppNavigator() {
	const { token, isLoading, init } = useAuthStore();
	const [minElapsed, setMinElapsed] = useState(false);

	useEffect(() => {
		init();
		const t = setTimeout(() => setMinElapsed(true), SPLASH_MIN_MS);
		return () => clearTimeout(t);
	}, [init]);

	if (isLoading || !minElapsed) {
		return <SplashScreen />;
	}

	return (
		<>
			{/* Prompts once on open when a newer APK is published (Android only). */}
			{token ? <UpdatePrompt /> : null}
			<NavigationContainer theme={VaultTheme} linking={linking}>
				<Stack.Navigator
					screenOptions={{
						headerShown: false,
						contentStyle: { backgroundColor: colors.bg },
					}}
				>
					{token ? (
						<>
							<Stack.Screen name="VaultHome" component={VaultHomeScreen} />
							{/* Storage handles its own left-edge back-swipe (folder-aware),
							    so the native pop gesture is disabled to avoid the two
							    competing. */}
							<Stack.Screen
								name="Storage"
								component={StorageScreen}
								options={{ gestureEnabled: false }}
							/>
							<Stack.Screen name="Calendar" component={CalendarScreen} />
							<Stack.Screen name="Tasks" component={TasksScreen} />
							<Stack.Screen name="Recorder" component={RecorderScreen} />
							<Stack.Screen name="Cron" component={CronScreen} />
							<Stack.Screen
								name="RecorderSessions"
								component={RecorderSessionsScreen}
							/>
							<Stack.Screen
								name="RecordingDetail"
								component={RecordingDetailScreen}
							/>
							<Stack.Screen name="Settings" component={SettingsScreen} />
							<Stack.Screen name="SettingsProfile" component={ProfileScreen} />
							<Stack.Screen
								name="SettingsAppearance"
								component={SpritePickerScreen}
							/>
							<Stack.Screen name="SettingsTrash" component={TrashScreen} />
							<Stack.Screen
								name="SettingsSecurity"
								component={SecurityScreen}
							/>
							<Stack.Screen name="SettingsMemory" component={MemoryScreen} />
							<Stack.Screen
								name="SettingsTokenUsage"
								component={TokenUsageScreen}
							/>
						</>
					) : (
						<Stack.Screen name="Login" component={LoginScreen} />
					)}
				</Stack.Navigator>
			</NavigationContainer>
		</>
	);
}
