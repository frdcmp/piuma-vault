import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../utils/theme";

// A few extra px on the top band so it sits slightly taller than the bare
// status-bar inset, giving a little breathing room above the header. Screens
// must pad their content by useTopInset() (not insets.top) so they start below
// this taller band instead of being overlapped by it.
export const TOP_EXTRA = 4;

// The effective top inset every screen should reserve for the status-bar band.
// Keeps the band height and screen padding in lockstep — change TOP_EXTRA once
// and both move together.
export function useTopInset() {
	return useSafeAreaInsets().top + TOP_EXTRA;
}

// Opaque band painted behind the bottom navigation/gesture bar. Exported on its
// own so it can also be dropped INSIDE a <Modal> — RN modals render in a
// separate native window above the app tree, so the root-level band below would
// otherwise be hidden by modal content (e.g. a bottom sheet). Render it as the
// modal's last child to keep the nav-bar zone solid and on top of everything.
export function BottomBar({ color = colors.bg }) {
	const insets = useSafeAreaInsets();
	return (
		<View
			pointerEvents="none"
			style={{
				position: "absolute",
				bottom: 0,
				left: 0,
				right: 0,
				height: insets.bottom,
				backgroundColor: color,
			}}
		/>
	);
}

// Opaque bands painted behind the Android/iOS system bars (status bar at the
// top, navigation/gesture bar at the bottom). In edge-to-edge mode the system
// bars are transparent and content draws under them — this guarantees a solid
// fill in those zones on every screen, mounted once at the app root. The bands
// are non-interactive so they never intercept touches meant for screen content.
export default function SystemBars({ color = colors.bg }) {
	const insets = useSafeAreaInsets();
	return (
		<>
			<View
				pointerEvents="none"
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					right: 0,
					height: insets.top + TOP_EXTRA,
					// keep in sync with useTopInset() above
					backgroundColor: color,
				}}
			/>
			<BottomBar color={color} />
		</>
	);
}
