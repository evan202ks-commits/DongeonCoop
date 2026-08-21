/**
 * Deuxieme salle : la crypte, accessible en franchissant la grande porte de
 * la salle de spawn (server/map.js) une fois ouverte.
 *
 * Meme principe que map.js : l'image `public/map/salle-donjon-2.png` EST la
 * carte, une coordonnee monde = un pixel de l'image. Les coordonnees des
 * obstacles ci-dessous ont ete releves sur cette image (F2 en jeu affiche la
 * grille pour les corriger si besoin).
 *
 * Cette salle n'a pas de mecanisme de porte a elle : son seul acces, au sud,
 * est une ouverture deja degagee (SOLIDS n'y met rien) qui ramene a la salle
 * de spawn. Voir GATE et ENTRY plus bas, et Room.checkZoneTransition().
 */

const IMAGE = '/map/salle-donjon-2.png';
const WIDTH = 1516;
const HEIGHT = 1037;
const CELL = 16;

const FLOOR = { x0: 94, y0: 68, x1: 1422, y1: 936 };

/** Largeur du passage sud, deja ouvert : aucun mur pose sur cette tranche. */
const GATE = { x0: 684, y0: FLOOR.y1, x1: 832, y1: HEIGHT };

const SOLIDS = [
  // --- Enceinte ------------------------------------------------------------
  [0, 0, WIDTH, FLOOR.y0],                       // mur du haut (arche fermee, decorative)
  [0, FLOOR.y1, GATE.x0, HEIGHT],                 // mur du bas, a gauche du passage
  [GATE.x1, FLOOR.y1, WIDTH, HEIGHT],             // mur du bas, a droite du passage
  [0, 0, FLOOR.x0, HEIGHT],                       // mur de gauche
  [FLOOR.x1, 0, WIDTH, HEIGHT],                   // mur de droite

  // --- Renfoncements lateraux (passages murees, comme la salle de spawn) --
  [94, 423, 198, 581],
  [1318, 423, 1422, 581],

  // --- Torches murales qui debordent sur la dalle --------------------------
  [88, 234, 132, 280],
  [1383, 236, 1427, 282],

  // --- Les quatre autels / brasiers ----------------------------------------
  [497, 242, 583, 398],
  [937, 241, 1023, 397],
  [498, 672, 584, 828],
  [936, 671, 1022, 827],

  // --- Mobilier --------------------------------------------------------------
  [120, 180, 270, 340],    // caisse + jarres, haut gauche
  [1240, 220, 1400, 370],  // jarres + amas d'ossements, haut droite
  [110, 760, 300, 900],    // jarres + ossements + rocher, bas gauche
  [1210, 710, 1420, 900]   // baril + caisse + jarres, bas droite
];

const FLAME_SPRITE = {
  image: '/map/flamme.png',
  frames: 8,
  width: 68,
  height: 95,
  frameMs: 110,
  intensity: [0.55, 0.68, 0.85, 0.95, 1, 0.88, 0.7, 0.58]
};

/** Memes teintes que la salle de spawn : violet des brasiers, mauve des torches. */
const FLAMES = [
  { x: 540, y: 277, scale: 0.80, phase: 0, rate: 1.00, glow: 150, color: '#a97bff' },
  { x: 980, y: 276, scale: 0.80, phase: 3, rate: 0.92, glow: 150, color: '#a97bff' },
  { x: 541, y: 707, scale: 0.80, phase: 5, rate: 1.07, glow: 150, color: '#a97bff' },
  { x: 979, y: 706, scale: 0.80, phase: 2, rate: 0.97, glow: 150, color: '#a97bff' },
  { x: 590, y: 100, scale: 0.62, phase: 6, rate: 1.11, glow: 115, color: '#b08cff' },
  { x: 926, y: 100, scale: 0.62, phase: 1, rate: 0.89, glow: 115, color: '#b08cff' },
  { x: 110, y: 257, scale: 0.58, phase: 4, rate: 1.04, glow: 100, color: '#b08cff' },
  { x: 1405, y: 259, scale: 0.58, phase: 7, rate: 0.95, glow: 100, color: '#b08cff' }
];

const LIGHTS = [
  { x: 758, y: 502, r: 190, color: '#b39ddb' }
];

/** Point d'arrivee en venant de la salle de spawn : juste au nord du passage. */
const ENTRY = { x: 758, y: 872, angle: -Math.PI / 2 };

const COLS = Math.ceil(WIDTH / CELL);
const ROWS = Math.ceil(HEIGHT / CELL);

function buildGrid() {
  const rows = [];
  for (let ry = 0; ry < ROWS; ry++) {
    let line = '';
    const cy = (ry + 0.5) * CELL;
    for (let cx = 0; cx < COLS; cx++) {
      const px = (cx + 0.5) * CELL;
      let solid = 0;
      for (const [x0, y0, x1, y1] of SOLIDS) {
        if (px >= x0 && px < x1 && cy >= y0 && cy < y1) { solid = 1; break; }
      }
      line += solid;
    }
    rows.push(line);
  }
  return rows;
}

const GRID = buildGrid();

function solidAt(col, row) {
  if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return true;
  return GRID[row].charCodeAt(col) === 49;
}

function blocked(x, y, r) {
  const c0 = Math.floor((x - r) / CELL);
  const c1 = Math.floor((x + r) / CELL);
  const r0 = Math.floor((y - r) / CELL);
  const r1 = Math.floor((y + r) / CELL);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (solidAt(col, row)) return true;
    }
  }
  return false;
}

function sweep(x, y, dx, dy, r) {
  if (dx === 0 && dy === 0) return 0;
  if (!blocked(x + dx, y + dy, r)) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (blocked(x + dx * mid, y + dy * mid, r)) hi = mid; else lo = mid;
  }
  return lo;
}

/** Le 4e argument (doorOpen) est ignore ici : cette salle n'a pas de porte a etat. */
function move(entity, dx, dy, r) {
  if (dx !== 0) entity.x += dx * sweep(entity.x, entity.y, dx, 0, r);
  if (dy !== 0) entity.y += dy * sweep(entity.x, entity.y, 0, dy, r);
  entity.x = Math.max(r, Math.min(WIDTH - r, entity.x));
  entity.y = Math.max(r, Math.min(HEIGHT - r, entity.y));
}

function nearestFree(x, y, r) {
  if (!blocked(x, y, r)) return { x, y };
  for (let ring = 1; ring <= 60; ring++) {
    const step = ring * CELL;
    for (let a = 0; a < 16; a++) {
      const angle = (a / 16) * Math.PI * 2;
      const nx = x + Math.cos(angle) * step;
      const ny = y + Math.sin(angle) * step;
      if (!blocked(nx, ny, r)) return { x: nx, y: ny };
    }
  }
  return { x: WIDTH / 2, y: HEIGHT / 2 };
}

function randomFree(r) {
  for (let i = 0; i < 200; i++) {
    const x = FLOOR.x0 + Math.random() * (FLOOR.x1 - FLOOR.x0);
    const y = FLOOR.y0 + Math.random() * (FLOOR.y1 - FLOOR.y0);
    if (!blocked(x, y, r)) return { x, y };
  }
  return { x: WIDTH / 2, y: HEIGHT / 2 };
}

function clientData() {
  return {
    image: IMAGE,
    width: WIDTH,
    height: HEIGHT,
    cell: CELL,
    cols: COLS,
    rows: ROWS,
    floor: FLOOR,
    lights: LIGHTS,
    flameSprite: FLAME_SPRITE,
    flames: FLAMES,
    door: null,          // pas de mecanisme dans cette salle
    grid: GRID.join('\n')
  };
}

module.exports = {
  IMAGE, WIDTH, HEIGHT, CELL, COLS, ROWS, FLOOR, SOLIDS, LIGHTS, GATE, ENTRY, GRID,
  FLAME_SPRITE, FLAMES,
  solidAt, blocked, sweep, move, nearestFree, randomFree, clientData
};
