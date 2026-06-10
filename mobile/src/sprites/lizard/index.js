// Lizard — the pixel reptile mascot.
//
// Same shape/contract as ./piuma (see ../index.js): a palette plus poses built
// from 10 shared `body` rows + two swappable leg rows. Keeps Piuma's leg
// columns (3,5,10,12) so the shared walk/gallop cycles work unchanged. The
// reptile read comes from the dorsal spikes (top), the snout + flicking tongue
// (left), and the tapering tail (right).

const palette = {
  B: '#5fb878', // green scales
  D: '#357a4b', // dark green — dorsal spikes & tail
  W: '#e3f2b0', // pale belly
  M: '#7fce95', // snout (lighter green)
  N: '#1f3a29', // nostril
  Y: '#ffd23f', // amber eye
  T: '#ff5a5f', // forked tongue
};

// Top 10 rows — spiny back, snout to the left, tail tapering to the right.
const body = [
  '................',
  '....D.D.D.D.....', // dorsal spikes
  '...BBBBBBBB.....', // back
  '..BBYBBBBBBB.DD.', // eye + back + tail
  'MMBBBBBBBBBBBDDD', // snout + body + tail
  'TBBNBBBBBBBBB.D.', // tongue + nostril + body + tail tip
  '..BBBBBBBBBBB...', // body
  '...BWWWWWWWWBB..', // belly
  '...BWWWWWWWWBB..', // belly
  '...BBBBBBBBBBB..', // underside
];

// Standing legs (cols 3,5,10,12 — same footprint as Piuma).
const idleLegs = ['...B.B....B.B...', '...B.B....B.B...'];

// Walk: 4-frame diagonal trot.
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
  name: 'lizard',
  palette,
  body,
  idleLegs,
  walkLegs,
  walkFrameMs: 120,
  gallopLegs,
  gallopFrameMs: 140,
};
