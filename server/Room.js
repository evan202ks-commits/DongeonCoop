const CONFIG = require('./config');

const COLORS = [
  '#4ade80', '#38bdf8', '#f97316', '#c084fc',
  '#facc15', '#fb7185', '#2dd4bf', '#a3e635'
];

let nextColor = 0;

function sanitizeName(raw) {
  const name = String(raw || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 14);
  return name || 'Aventurier';
}

/**
 * Une salle = un terrain plat partage + les joueurs dessus.
 * Le serveur est autoritatif : il possede les positions, le client ne fait que predire.
 */
class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.spawnCursor = 0;
    this.tick = 0;
  }

  get count() {
    return this.players.size;
  }

  isFull() {
    return this.players.size >= CONFIG.PLAYER.maxPerRoom;
  }

  /** Point de depot sur le terrain : repartition reguliere sur un anneau autour du centre. */
  nextSpawn() {
    const { width, height } = CONFIG.WORLD;
    const { ringRadius, slots } = CONFIG.SPAWN;
    const index = this.spawnCursor++ % slots;
    const angle = (index / slots) * Math.PI * 2;
    return {
      x: width / 2 + Math.cos(angle) * ringRadius,
      y: height / 2 + Math.sin(angle) * ringRadius,
      angle: angle + Math.PI // face au centre
    };
  }

  add(id, rawName) {
    const spawn = this.nextSpawn();
    const player = {
      id,
      name: sanitizeName(rawName),
      color: COLORS[nextColor++ % COLORS.length],
      x: spawn.x,
      y: spawn.y,
      dx: 0,
      dy: 0,
      angle: spawn.angle,
      state: 'dropping',            // 'dropping' -> 'active'
      dropUntil: Date.now() + CONFIG.SPAWN.dropMs,
      pending: [],                  // commandes d'input en attente
      lastSeq: 0,
      dtBudget: 0,                  // anti speed-hack
      lastBudgetAt: Date.now()
    };
    this.players.set(id, player);
    return player;
  }

  remove(id) {
    const player = this.players.get(id);
    this.players.delete(id);
    return player;
  }

  /** Commande d'input du client : { seq, dt, ax, ay }. */
  queueInput(id, cmd) {
    const player = this.players.get(id);
    if (!player || !cmd) return;
    const seq = Number(cmd.seq) || 0;
    if (seq <= player.lastSeq) return; // doublon ou paquet en retard
    if (player.pending.length > 60) player.pending.shift();
    player.pending.push({
      seq,
      dt: Math.min(Math.max(Number(cmd.dt) || 0, 0), CONFIG.NET.maxDt),
      ax: Math.max(-1, Math.min(1, Number(cmd.ax) || 0)),
      ay: Math.max(-1, Math.min(1, Number(cmd.ay) || 0))
    });
  }

  /** Applique une commande. Meme fonction cote client pour la prediction. */
  static applyInput(player, cmd) {
    let { ax, ay } = cmd;
    const len = Math.hypot(ax, ay);
    if (len > 1) { ax /= len; ay /= len; }

    const speed = CONFIG.PLAYER.speed;
    player.x += ax * speed * cmd.dt;
    player.y += ay * speed * cmd.dt;
    player.dx = ax;
    player.dy = ay;
    if (len > 0.01) player.angle = Math.atan2(ay, ax);

    Room.clampToWorld(player);
  }

  static clampToWorld(player) {
    const r = CONFIG.PLAYER.radius;
    const { width, height } = CONFIG.WORLD;
    player.x = Math.max(r, Math.min(width - r, player.x));
    player.y = Math.max(r, Math.min(height - r, player.y));
  }

  step(dt) {
    this.tick++;
    const now = Date.now();

    for (const player of this.players.values()) {
      // Fin de la chute : le joueur touche le sol et devient jouable.
      if (player.state === 'dropping') {
        if (now >= player.dropUntil) player.state = 'active';
        player.pending.length = 0;
        continue;
      }

      // Budget de temps : un client ne peut pas envoyer plus de dt que le temps reel ecoule.
      player.dtBudget += ((now - player.lastBudgetAt) / 1000) * 1.15;
      player.lastBudgetAt = now;
      player.dtBudget = Math.min(player.dtBudget, 0.5);

      let moved = false;
      let i = 0;
      for (; i < player.pending.length; i++) {
        const cmd = player.pending[i];
        if (cmd.dt > player.dtBudget) break; // budget epuise : on reprendra au prochain tick
        player.dtBudget -= cmd.dt;
        Room.applyInput(player, cmd);
        player.lastSeq = cmd.seq;
        moved = true;
      }
      player.pending = player.pending.slice(i, i + 30);
      if (!moved) { player.dx = 0; player.dy = 0; }
    }

    this.resolveOverlaps();
  }

  /** Separation douce pour eviter que deux joueurs occupent la meme case. */
  resolveOverlaps() {
    const list = [...this.players.values()].filter(p => p.state === 'active');
    const minDist = CONFIG.PLAYER.radius * 2;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist === 0) { dx = 0.01; dy = 0; dist = 0.01; }
        if (dist >= minDist) continue;

        const push = (minDist - dist) / 2;
        const nx = dx / dist, ny = dy / dist;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        Room.clampToWorld(a);
        Room.clampToWorld(b);
      }
    }
  }

  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        n: p.name,
        c: p.color,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        a: Math.round(p.angle * 100) / 100,
        m: p.dx !== 0 || p.dy !== 0 ? 1 : 0,
        st: p.state === 'dropping' ? 1 : 0,
        seq: p.lastSeq
      });
    }
    return { t: Date.now(), tick: this.tick, players };
  }
}

module.exports = { Room, sanitizeName };
