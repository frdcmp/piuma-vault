// ============================================================================
//  MASCOT SPRITES
//
//  The active mascot now lives in the DB and is selected in the admin Appearance
//  page — no code change needed to switch or add characters. Components read it
//  via `useSprite()` (provided by <SpriteProvider>, near the app root).
//
//  `./piuma` remains as the baked-in default used for first paint / offline /
//  pre-provider fallback (see SpriteProvider).
// ============================================================================

export { default as Sprite } from "./Sprite";
export { SpriteProvider, useSprite } from "./SpriteProvider";
export { default as useSpriteCycle } from "./useSpriteCycle";

// Which frame of a `frameCount`-long cycle is showing at `elapsedMs`. Pure, so
// it works equally for interval- and requestAnimationFrame-driven animations.
export const legFrameAt = (elapsedMs, frameCount, frameMs) =>
	Math.floor(elapsedMs / frameMs) % frameCount;
