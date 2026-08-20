/**
 * Collisions de la salle, cote client.
 *
 * Copie a l'identique de la logique de server/map.js : la prediction locale doit
 * heurter exactement les memes murs que la simulation serveur, sinon la
 * reconciliation passe son temps a corriger le joueur contre les obstacles.
 * Toute modification ici doit etre reportee dans server/map.js, et inversement.
 *
 * La grille arrive dans CONFIG.MAP (une ligne de '0'/'1' par rangee de cases).
 */
export class Collision {
  constructor(map) {
    this.cell = map.cell;
    this.cols = map.cols;
    this.rows = map.rows;
    this.width = map.width;
    this.height = map.height;
    this.grid = map.grid.split('\n');
  }

  solidAt(col, row) {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return true;
    return this.grid[row].charCodeAt(col) === 49; // '1'
  }

  /** Le joueur est traite comme un carre de cote 2r. */
  blocked(x, y, r) {
    const cell = this.cell;
    const c0 = Math.floor((x - r) / cell);
    const c1 = Math.floor((x + r) / cell);
    const r0 = Math.floor((y - r) / cell);
    const r1 = Math.floor((y + r) / cell);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        if (this.solidAt(col, row)) return true;
      }
    }
    return false;
  }

  /** Plus grande fraction du deplacement qui reste libre, par dichotomie. */
  sweep(x, y, dx, dy, r) {
    if (dx === 0 && dy === 0) return 0;
    if (!this.blocked(x + dx, y + dy, r)) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (this.blocked(x + dx * mid, y + dy * mid, r)) hi = mid; else lo = mid;
    }
    return lo;
  }

  /** Deplacement complet : X puis Y, chacun bloque independamment. */
  move(entity, dx, dy, r) {
    if (dx !== 0) entity.x += dx * this.sweep(entity.x, entity.y, dx, 0, r);
    if (dy !== 0) entity.y += dy * this.sweep(entity.x, entity.y, 0, dy, r);
    entity.x = Math.max(r, Math.min(this.width - r, entity.x));
    entity.y = Math.max(r, Math.min(this.height - r, entity.y));
  }
}
