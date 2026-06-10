// Bubu — the pixel cat mascot.
//
// Same shape/contract as ./piuma (see ../index.js): a palette plus poses built
// from 10 shared `body` rows + two swappable leg rows. Bubu keeps the exact
// leg columns Piuma uses (3,5,10,12), so the shared walk/gallop leg cycles work
// unchanged — only the head (pointy ears, cat eyes), tail, and palette differ.

const palette = {
  B: '#8d93a0', // gray fur
  W: '#eceef2', // white chest / belly
  M: '#eceef2', // muzzle (white)
  N: '#ff8fab', // pink nose
  Y: '#7ee787', // green eyes
  P: '#ffb3c6', // pink inner ear
  T: '#e76f8a', // mouth
  C: '#39c5bb', // collar (teal)
};

// Top 10 rows — pointy-eared cat head on the left, upright tail on the right.
const body = [
  '....B...B....B..', // ear tips + tail tip
  '...BPB.BPB...B..', // ears (pink inner) + tail
  '...BBBBBBB...B..', // head top + tail
  '...BYBBBYB...B..', // eyes + tail
  '...BBMNMBBBBBB..', // muzzle / nose + shoulders + tail base
  '...BMMTMBBBBBBB.', // mouth + back + rump
  '...BBBBBBBBBBBB.', // lower body
  '...CCCCCCCCCCC..', // collar
  '...BWWWWWWWWBB..', // belly
  '...BWWWWWWWWBB..', // belly
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
  name: 'bubu',
  palette,
  body,
  idleLegs,
  walkLegs,
  walkFrameMs: 120,
  gallopLegs,
  gallopFrameMs: 140,
};
