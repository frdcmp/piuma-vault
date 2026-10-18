import "./tokens.css";
import "./reset.css";
import "./base.css";
import "./vault-pixel.css";

export { defaultTheme, staticTokens, themes } from "./tokens.js";
export {
	applyTheme,
	currentTokens,
	THEME_STORAGE_KEY,
	useTheme,
} from "./useTheme.js";
