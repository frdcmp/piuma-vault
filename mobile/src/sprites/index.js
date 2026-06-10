// ============================================================================
//  ACTIVE MASCOT
//
//  Every component renders whatever character this points at. To re-skin the
//  whole app, add a sibling folder (e.g. ./bubu) exporting the same shape as
//  ./piuma, then swap the import below:
//
//      import character from './piuma';
//   // import character from './bubu';
// ============================================================================
import character from './lizard';

// --- Identity / colors -------------------------------------------------------
export const SPRITE_NAME = character.name;
export const PALETTE = character.palette;
export const spriteColor = (code) => character.palette[code] || 'transparent';

// --- Poses -------------------------------------------------------------------
// Shared top rows; only the legs change between poses.
export const BODY = character.body;
export const IDLE_LEGS = character.idleLegs;
// Full static standing sprite (body + idle legs).
export const SPRITE = [...character.body, ...character.idleLegs];

// Walk / gallop leg cycles and their per-frame durations.
export const WALK_LEGS = character.walkLegs;
export const WALK_FRAME_MS = character.walkFrameMs;
export const GALLOP_LEGS = character.gallopLegs;
export const GALLOP_FRAME_MS = character.gallopFrameMs;

// --- Geometry ----------------------------------------------------------------
export const COLS = character.body[0].length;
export const ROWS = SPRITE.length;

// Which frame of a `frameCount`-long cycle is showing at `elapsedMs`. Pure, so
// it works equally for interval- and requestAnimationFrame-driven animations.
export const legFrameAt = (elapsedMs, frameCount, frameMs) =>
  Math.floor(elapsedMs / frameMs) % frameCount;

// --- Shared renderer ---------------------------------------------------------
export { default as Sprite } from './Sprite';
