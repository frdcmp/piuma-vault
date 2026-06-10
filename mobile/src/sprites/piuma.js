// Single source of truth for the Piuma pixel sprite (mobile).
//
// A pose is an array of equal-length strings; each character is a pixel "code"
// mapped to a color by PIUMA_PALETTE ('.' or any unknown code = transparent).
// The top 10 BODY rows are shared by every pose — only the two leg rows change,
// which is how the idle / walk / gallop cycles are built.

export const PIUMA_PALETTE = {
  B: '#ad7549', // base fur
  W: '#f5f5f5', // belly
  M: '#f5f5f5', // muzzle
  E: '#0d0d0d', // ear
  N: '#000000', // nose
  Y: '#090909', // eye
  T: '#ff7a9a', // tongue
  C: '#c0392b', // collar
};

export const piumaColor = (code) => PIUMA_PALETTE[code] || 'transparent';

// Top 10 rows — identical across every pose.
export const PIUMA_BODY = [
  '................',
  '.....EEBB.......',
  '....EBBBBB......',
  '...BBBBBBBB.....',
  '...BBYBBYBB.BBB.',
  '...BMMNMMBBBBBB.',
  '...BBMTMBBBBBBB.',
  '...CCCCCCCCCCC..',
  '...BWWWWWWWWBB..',
  '...BWWWWWWWWBB..',
];

// Standing legs.
export const PIUMA_IDLE_LEGS = ['...B.B....B.B...', '...B.B....B.B...'];

// Full static sprite (standing pose) — body + idle legs.
export const PIUMA_SPRITE = [...PIUMA_BODY, ...PIUMA_IDLE_LEGS];

export const PIUMA_COLS = PIUMA_BODY[0].length;
export const PIUMA_ROWS = PIUMA_SPRITE.length;

// Walk: 4-frame diagonal trot. Each diagonal pair of legs swings forward
// (lifted — no foot row) while the other pair stays planted, with a neutral
// contact frame between steps. All feet stay under the body (cols 2–12).
export const PIUMA_WALK_LEGS = [
  ['..B..B....BB....', '.....B....B.....'], // front-left + back-right swing
  PIUMA_IDLE_LEGS,
  ['...BB....B..B...', '...B........B...'], // front-right + back-left swing
  PIUMA_IDLE_LEGS,
];
export const PIUMA_WALK_FRAME_MS = 120;

// Gallop: 2-frame run used by the loading spinner / running loader.
export const PIUMA_GALLOP_LEGS = [
  ['..B.B.....B.B...', '..B.B.......B.B.'],
  ['....B.B...B.B...', '....B.B..B.B....'],
];
export const PIUMA_GALLOP_FRAME_MS = 140;

// Which frame of a `frameCount`-long cycle is showing at `elapsedMs`. Pure, so
// it works equally for interval- and requestAnimationFrame-driven animations.
export const legFrameAt = (elapsedMs, frameCount, frameMs) =>
  Math.floor(elapsedMs / frameMs) % frameCount;
