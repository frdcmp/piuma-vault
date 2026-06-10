// Piuma — the pixel dog mascot.
//
// A character definition: a palette plus a set of poses. A pose is an array of
// equal-length strings; each character is a pixel "code" mapped to a color by
// the palette ('.' or any unknown code = transparent). The top 10 `body` rows
// are shared by every pose — only the two leg rows change, which is how the
// idle / walk / gallop cycles are built.
//
// Consumed generically through ../index.js — swap the active character there to
// re-skin the whole app.

const palette = {
  B: '#ad7549', // base fur
  W: '#f5f5f5', // belly
  M: '#f5f5f5', // muzzle
  E: '#0d0d0d', // ear
  N: '#000000', // nose
  Y: '#090909', // eye
  T: '#ff7a9a', // tongue
  C: '#c0392b', // collar
};

// Top 10 rows — identical across every pose.
const body = [
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
const idleLegs = ['...B.B....B.B...', '...B.B....B.B...'];

// Walk: 4-frame diagonal trot. Each diagonal pair of legs swings forward
// (lifted — no foot row) while the other pair stays planted, with a neutral
// contact frame between steps. All feet stay under the body (cols 2–12).
const walkLegs = [
  ['..B..B....BB....', '.....B....B.....'], // front-left + back-right swing
  idleLegs,
  ['...BB....B..B...', '...B........B...'], // front-right + back-left swing
  idleLegs,
];

// Gallop: 2-frame run used by the running loader.
const gallopLegs = [
  ['..B.B.....B.B...', '..B.B.......B.B.'],
  ['....B.B...B.B...', '....B.B..B.B....'],
];

export default {
  name: 'piuma',
  palette,
  body,
  idleLegs,
  walkLegs,
  walkFrameMs: 120,
  gallopLegs,
  gallopFrameMs: 140,
};
