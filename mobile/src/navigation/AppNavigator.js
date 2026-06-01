import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import LoginScreen from "../screens/LoginScreen";
import SplashScreen from "../screens/SplashScreen";
import StorageScreen from "../screens/StorageScreen";
import VaultHomeScreen from "../screens/VaultHomeScreen";
import { useAuthStore } from "../stores/authStore";
import { colors } from "../utils/theme";

// Minimum time the splash stays on screen — so users always get to see Piuma
// running, even if storage reads finish in a few ms.
const SPLASH_MIN_MS = 3000;

const Stack = createNativeStackNavigator();

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
		<NavigationContainer theme={VaultTheme}>
			<Stack.Navigator
				screenOptions={{
					headerShown: false,
					contentStyle: { backgroundColor: colors.bg },
				}}
			>
				{token ? (
					<>
						<Stack.Screen name="VaultHome" component={VaultHomeScreen} />
						<Stack.Screen name="Storage" component={StorageScreen} />
					</>
				) : (
					<Stack.Screen name="Login" component={LoginScreen} />
				)}
			</Stack.Navigator>
		</NavigationContainer>
	);
}
