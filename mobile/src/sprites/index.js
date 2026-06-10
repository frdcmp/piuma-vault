// ============================================================================
//  MASCOT SPRITES (mobile)
//
//  The active mascot lives in the DB and is selected in the web admin Appearance
//  page. Components read it via `useSprite()` (provided by <SpriteProvider> at
//  the app root). `./fallback-sprite` is the baked-in default for cold-launch /
//  offline fallback.
// ============================================================================
export { SpriteProvider, useSprite } from './SpriteProvider';
export { default as Sprite } from './Sprite';

// Which frame of a `frameCount`-long cycle is showing at `elapsedMs`. Pure.
export const legFrameAt = (elapsedMs, frameCount, frameMs) =>
  Math.floor(elapsedMs / frameMs) % frameCount;
