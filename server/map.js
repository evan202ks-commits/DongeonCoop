/**
 * La salle de donjon : geometrie, collisions et points de depot.
 *
 * L'image `public/map/salle-donjon.png` EST la carte : le monde fait exactement
 * sa taille en pixels, donc une coordonnee monde = un pixel de l'image. Pour
 * ajuster un obstacle, il suffit de lire les coordonnees sur l'image et de
 * corriger le rectangle correspondant ci-dessous (F2 en jeu affiche la grille).
 *
 * Ce module ne depend de rien : config.js le lit, jamais l'inverse.
 */

const IMAGE = '/map/salle-donjon.png';
const WIDTH = 1672;
const HEIGHT = 941;
const CELL = 16;               // finesse de la grille de collision, en px monde

// Dalle jouable, hors murs (mesuree sur l'image).
const FLOOR = { x0: 256, y0: 182, x1: 1414, y1: 814 };

/**
 * Obstacles, en pixels image : [x0, y0, x1, y1].
 * Tout ce qui n'est pas liste est traversable — les os, les mousses, la grille
 * d'egout et les banderoles sont du decor peint au sol, on marche dessus.
 */
const SOLIDS = [
  // --- Enceinte : tout ce qui est hors de la dalle -----------------------
  [0, 0, WIDTH, FLOOR.y0],                 // mur du haut (porche + herse)
  [0, FLOOR.y1, WIDTH, HEIGHT],            // mur du bas (escalier de sortie)
  [0, 0, FLOOR.x0, HEIGHT],                // mur de gauche
  [FLOOR.x1, 0, WIDTH, HEIGHT],            // mur de droite

  // --- Renfoncements lateraux (passages murees) --------------------------
  [256, 458, 360, 616],
  [1312, 458, 1414, 616],

  // --- Torches murales qui debordent sur la dalle ------------------------
  [256, 232, 300, 278],
  [1370, 232, 1414, 278],

  // --- Les quatre autels / brasiers --------------------------------------
  [578, 296, 664, 452],
  [1004, 295, 1090, 451],
  [578, 543, 664, 699],
  [1004, 543, 1090, 699],

  // --- Mobilier ----------------------------------------------------------
  [300, 182, 402, 278],    // caisses en bois, haut gauche
  [402, 206, 438, 252],    // jarre isolee, haut gauche
  [256, 330, 348, 422],    // jarres, mur gauche
  [256, 738, 366, 814],    // jarres, bas gauche
  [1286, 228, 1348, 288],  // jarre, haut droite
  [1196, 258, 1256, 308],  // rocher, haut droite
  [1322, 656, 1390, 762],  // baril, bas droite
  [1260, 752, 1376, 814]   // caisse, bas droite
];

/**
 * Sources lumineuses : le client les fait respirer par-dessus l'image fixe,
 * c'est ce qui donne l'impression que la salle est vivante.
 */
const LIGHTS = [
  { x: 620, y: 309, r: 140, color: '#7cd9ff' },   // brasier haut gauche
  { x: 1047, y: 308, r: 140, color: '#7cd9ff' },  // brasier haut droite
  { x: 622, y: 555, r: 140, color: '#7cd9ff' },   // brasier bas gauche
  { x: 1046, y: 555, r: 140, color: '#7cd9ff' },  // brasier bas droite
  { x: 653, y: 112, r: 110, color: '#8ad4ff' },   // applique du porche, gauche
  { x: 1018, y: 110, r: 110, color: '#8ad4ff' },  // applique du porche, droite
  { x: 276, y: 254, r: 100, color: '#8ad4ff' },   // torche murale gauche
  { x: 1393, y: 253, r: 100, color: '#8ad4ff' },  // torche murale droite
  { x: 836, y: 498, r: 190, color: '#b39ddb' }    // sceau central
];

const COLS = Math.ceil(WIDTH / CELL);
const ROWS = Math.ceil(HEIGHT / CELL);

/** Rasterisation : une case est solide si son centre tombe dans un obstacle. */
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
  return GRID[row].charCodeAt(col) === 49; // '1'
}

/** Le joueur est traite comme un carre de cote 2r : glissement propre le long des murs. */
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

/**
 * Avance d'un axe a la fois, avec recherche dichotomique de la plus grande
 * fraction libre : on colle au mur au lieu de s'arreter a dix pixels.
 * Ce code est duplique a l'identique dans public/js/collision.js — les deux
 * copies doivent rester synchronisees, sinon la prediction client derive.
 */
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

/** Deplacement complet : X puis Y, chacun bloque independamment. */
function move(entity, dx, dy, r) {
  if (dx !== 0) entity.x += dx * sweep(entity.x, entity.y, dx, 0, r);
  if (dy !== 0) entity.y += dy * sweep(entity.x, entity.y, 0, dy, r);
  entity.x = Math.max(r, Math.min(WIDTH - r, entity.x));
  entity.y = Math.max(r, Math.min(HEIGHT - r, entity.y));
}

/** Point libre le plus proche : rattrape une position sauvegardee devenue murale. */
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

/** Position au hasard sur la dalle, utilisee pour faire tomber le butin. */
function randomFree(r) {
  for (let i = 0; i < 200; i++) {
    const x = FLOOR.x0 + Math.random() * (FLOOR.x1 - FLOOR.x0);
    const y = FLOOR.y0 + Math.random() * (FLOOR.y1 - FLOOR.y0);
    if (!blocked(x, y, r)) return { x, y };
  }
  return { x: WIDTH / 2, y: HEIGHT / 2 };
}

/**
 * Points de depot : le long de la croix centrale et dans les quatre quartiers,
 * recales sur une case libre au chargement (une valeur approximative suffit).
 */
const SPAWNS = [
  { x: 836, y: 240 }, { x: 836, y: 330 }, { x: 836, y: 680 }, { x: 836, y: 770 },
  { x: 500, y: 498 }, { x: 700, y: 498 }, { x: 972, y: 498 }, { x: 1180, y: 498 },
  { x: 470, y: 300 }, { x: 1150, y: 340 }, { x: 470, y: 700 }, { x: 1180, y: 700 },
  { x: 720, y: 230 }, { x: 950, y: 230 }, { x: 720, y: 760 }, { x: 950, y: 760 }
].map(p => {
  const free = nearestFree(p.x, p.y, 20);
  const angle = Math.atan2(HEIGHT / 2 - free.y, WIDTH / 2 - free.x); // regard vers le sceau
  return { x: Math.round(free.x), y: Math.round(free.y), angle: Math.round(angle * 100) / 100 };
});

/** Ce que le client recoit : de quoi dessiner la salle et predire les collisions. */
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
    grid: GRID.join('\n')
  };
}

module.exports = {
  IMAGE, WIDTH, HEIGHT, CELL, COLS, ROWS, FLOOR, SOLIDS, LIGHTS, SPAWNS, GRID,
  solidAt, blocked, sweep, move, nearestFree, randomFree, clientData
};
