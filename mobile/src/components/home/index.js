import MenuClassic from "./MenuClassic";
import MenuConstellation from "./MenuConstellation";
import MenuDial from "./MenuDial";
import MenuFan from "./MenuFan";
import MenuOrbital from "./MenuOrbital";

// Registry of selectable home-menu layouts. The `key` is what gets persisted in
// prefsStore; `label` is shown in the switcher. Order here is the cycle order.
export const HOME_MENUS = [
	{ key: "classic", label: "Classic", Component: MenuClassic },
	{ key: "orbital", label: "Orbital", Component: MenuOrbital },
	{ key: "dial", label: "Dial", Component: MenuDial },
	{ key: "fan", label: "Fan", Component: MenuFan },
	{ key: "constellation", label: "Starmap", Component: MenuConstellation },
];

export const HOME_MENU_KEYS = HOME_MENUS.map((m) => m.key);

export function getHomeMenu(key) {
	return HOME_MENUS.find((m) => m.key === key) || HOME_MENUS[0];
}

export { default as MenuSwitcher } from "./MenuSwitcher";
