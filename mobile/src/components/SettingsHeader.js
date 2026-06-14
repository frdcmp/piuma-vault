import ScreenHeader from "./ScreenHeader";

// Thin alias kept for the Settings stack's existing imports. The shared bar now
// lives in ScreenHeader (used by every screen) — see it for the real props.
export default function SettingsHeader(props) {
	return <ScreenHeader {...props} />;
}
