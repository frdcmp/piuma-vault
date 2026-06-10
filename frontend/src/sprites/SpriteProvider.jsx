import { createContext, useContext, useMemo } from "react";
import { useActiveSprite } from "../queries/spritesQuery";
import DEFAULT_CHARACTER from "./fallback-sprite";

// Provides the active mascot (fetched from the DB) to the whole tree.
//
// `ready` distinguishes "we have the real answer" from "still waiting". While
// the query is in flight we report ready:false so consumers render nothing —
// this avoids the flash where the baked-in default paints first and then gets
// swapped for the DB sprite a moment later. The baked-in default is only ever
// shown when the backend actually ERRORS (ready:true, but with DEFAULT).

const SpriteContext = createContext(null);

// Normalize a raw character definition (DB or baked-in) into the shape every
// consumer reads, with derived `sprite` (standing pose) and `spriteColor`.
function normalize(def, name) {
	const palette = def.palette || {};
	const body = def.body || [];
	const idleLegs = def.idleLegs || [];
	return {
		name: name || def.name || "sprite",
		palette,
		body,
		idleLegs,
		walkLegs: def.walkLegs?.length ? def.walkLegs : [idleLegs],
		walkFrameMs: def.walkFrameMs || 120,
		gallopLegs: def.gallopLegs?.length ? def.gallopLegs : [idleLegs],
		gallopFrameMs: def.gallopFrameMs || 140,
		sprite: [...body, ...idleLegs],
		spriteColor: (code) => palette[code] || "transparent",
	};
}

const DEFAULT = normalize(DEFAULT_CHARACTER, DEFAULT_CHARACTER.name);
// Loading: hold (consumers render nothing). Error fallback: the baked-in default.
const LOADING = { ...DEFAULT, ready: false };
const FALLBACK = { ...DEFAULT, ready: true };

export function SpriteProvider({ children }) {
	const { data, isError } = useActiveSprite();
	const value = useMemo(() => {
		if (data?.definition)
			return { ...normalize(data.definition, data.name), ready: true };
		if (isError) return FALLBACK; // backend failed — show the baked-in default
		return LOADING; // still fetching — don't paint a soon-to-be-swapped sprite
	}, [data, isError]);
	return (
		<SpriteContext.Provider value={value}>{children}</SpriteContext.Provider>
	);
}

// The active mascot. Safe outside a provider — returns the baked-in default.
export function useSprite() {
	return useContext(SpriteContext) || FALLBACK;
}
