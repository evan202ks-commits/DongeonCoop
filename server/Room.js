const crypto = require('crypto');
const CONFIG = require('./config');
const Inventory = require('./inventory');
const Classes = require('./classes');
const { ITEMS, randomType, isValidType, isDroppable } = require('./items');

/**
 * Une salle = un terrain plat partage + les joueurs et le butin dessus.
 * Le serveur est autoritatif : positions et inventaires vivent ici, le client predit.
 */
class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.ground = new Map();          // objets poses sur le terrain
    this.spawnCursor = 0;
    this.tick = 0;
    this.events = [];                 // evenements a diffuser apres le pas de simulation
    this.nextLootAt = Date.now() + 1000;
  }

  get count() {
    return this.players.size;
  }

  isFull() {
    return this.players.size >= CONFIG.PLAYER.maxPerRoom;
  }

  /** Point de depot des nouveaux comptes : repartition reguliere sur un anneau. */
  nextSpawn() {
    const { width, height } = CONFIG.WORLD;
    const { ringRadius, slots } = CONFIG.SPAWN;
    const index = this.spawnCursor++ % slots;
    const angle = (index / slots) * Math.PI * 2;
    return {
      x: width / 2 + Math.cos(angle) * ringRadius,
      y: height / 2 + Math.sin(angle) * ringRadius,
      angle: angle + Math.PI
    };
  }

  /**
   * Ajoute un joueur a partir de son profil de compte.
   * Position sauvegardee si le compte en a une, sinon depot sur l'anneau.
   */
  add(socketId, profile) {
    const saved = profile.position;
    const spawn = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
      ? { x: saved.x, y: saved.y, angle: saved.angle || 0 }
      : this.nextSpawn();

    const classId = Classes.isValidClass(profile.classId) ? profile.classId : Classes.CLASS_IDS[0];
    const equipment = Classes.sanitizeEquipment(classId, profile.equipment);

    const player = {
      id: socketId,
      accountId: profile.accountId,
      name: profile.name,
      classId,
      color: Classes.CLASSES[classId].color,   // couleur de la classe
      tint: profile.color,                      // couleur du compte : distingue deux joueurs de la meme classe
      equipment,
      x: spawn.x,
      y: spawn.y,
      dx: 0,
      dy: 0,
      angle: spawn.angle,
      restored: !!saved,               // reprise de partie ou premier depot
      inventory: new Inventory(profile.inventory),
      stats: { ...profile.stats },
      attrs: Classes.resolveStats(classId, equipment),
      state: 'dropping',
      dropUntil: Date.now() + CONFIG.SPAWN.dropMs,
      joinedAt: Date.now(),
      pending: [],
      lastSeq: 0,
      dtBudget: 0,
      lastBudgetAt: Date.now()
    };

    Room.clampToWorld(player);
    this.players.set(socketId, player);
    return player;
  }

  remove(socketId) {
    const player = this.players.get(socketId);
    this.players.delete(socketId);
    return player;
  }

  /** Etat a persister sur le compte du joueur. */
  saveSnapshot(player) {
    const now = Date.now();
    const stats = {
      ...player.stats,
      playtimeMs: (player.stats.playtimeMs || 0) + (now - player.joinedAt)
    };
    player.joinedAt = now; // evite de compter deux fois lors des autosaves
    player.stats.playtimeMs = stats.playtimeMs;

    return {
      position: { x: player.x, y: player.y, angle: player.angle },
      inventory: player.inventory.toJSON(),
      equipment: player.equipment,
      stats
    };
  }

  // --- Entrees ----------------------------------------------------------
  queueInput(socketId, cmd) {
    const player = this.players.get(socketId);
    if (!player || !cmd) return;
    const seq = Number(cmd.seq) || 0;
    if (seq <= player.lastSeq) return;
    if (player.pending.length > 60) player.pending.shift();
    player.pending.push({
      seq,
      dt: Math.min(Math.max(Number(cmd.dt) || 0, 0), CONFIG.NET.maxDt),
      ax: Math.max(-1, Math.min(1, Number(cmd.ax) || 0)),
      ay: Math.max(-1, Math.min(1, Number(cmd.ay) || 0))
    });
  }

  /** Applique une commande. Le client execute exactement la meme chose en prediction. */
  static applyInput(player, cmd) {
    let { ax, ay } = cmd;
    const len = Math.hypot(ax, ay);
    if (len > 1) { ax /= len; ay /= len; }

    const speed = (player.attrs && player.attrs.speed) || CONFIG.PLAYER.speed;
    player.x += ax * speed * cmd.dt;
    player.y += ay * speed * cmd.dt;
    player.dx = ax;
    player.dy = ay;
    if (len > 0.01) player.angle = Math.atan2(ay, ax);

    Room.clampToWorld(player);
  }

  static clampToWorld(entity) {
    const r = CONFIG.PLAYER.radius;
    const { width, height } = CONFIG.WORLD;
    entity.x = Math.max(r, Math.min(width - r, entity.x));
    entity.y = Math.max(r, Math.min(height - r, entity.y));
  }

  // --- Butin ------------------------------------------------------------
  spawnLoot() {
    const { width, height } = CONFIG.WORLD;
    const margin = 60;
    const item = {
      id: crypto.randomBytes(6).toString('hex'),
      type: randomType(),
      qty: 1,
      x: margin + Math.random() * (width - margin * 2),
      y: margin + Math.random() * (height - margin * 2),
      pickupAfter: 0
    };
    this.ground.set(item.id, item);
    return item;
  }

  /** Jette un objet de l'inventaire sur le sol, devant le joueur. */
  dropItem(socketId, slotIndex) {
    const player = this.players.get(socketId);
    if (!player || player.state !== 'active') return null;

    const index = Math.floor(Number(slotIndex));
    if (!(index >= 0 && index < CONFIG.INVENTORY.slots)) return null;

    const peek = player.inventory.slots[index];
    if (!peek || !isDroppable(peek.type)) {
      if (peek) this.events.push({ type: 'notice', playerId: socketId, msg: 'Un artefact de classe ne se jette pas.' });
      return null;
    }

    const type = player.inventory.removeOne(index);
    if (!type) return null;

    const item = {
      id: crypto.randomBytes(6).toString('hex'),
      type,
      qty: 1,
      x: player.x + Math.cos(player.angle) * 34,
      y: player.y + Math.sin(player.angle) * 34,
      pickupAfter: Date.now() + CONFIG.INVENTORY.dropCooldownMs
    };
    Room.clampToWorld(item);
    this.ground.set(item.id, item);

    this.events.push({ type: 'inventory', playerId: socketId });
    return item;
  }

  // --- Artefacts / equipement -------------------------------------------
  /** Recalcule vitesse, portee et chance apres un changement d'equipement. */
  refreshAttrs(player) {
    player.attrs = Classes.resolveStats(player.classId, player.equipment);
    return player.attrs;
  }

  /**
   * Equipe un artefact pris dans l'inventaire. L'artefact deja porte dans le
   * meme emplacement retourne dans l'inventaire : rien ne se perd.
   */
  equip(socketId, type) {
    const player = this.players.get(socketId);
    if (!player) return false;

    const art = Classes.ARTIFACTS[type];
    if (!art || art.classId !== player.classId) {
      this.events.push({ type: 'notice', playerId: socketId, msg: 'Cet artefact appartient à une autre classe.' });
      return false;
    }
    if (!player.inventory.has(type)) return false;

    const previous = player.equipment[art.slot];
    if (previous === type) return false;

    player.inventory.removeType(type);
    player.equipment[art.slot] = type;
    if (previous) player.inventory.add(previous, 1);

    this.refreshAttrs(player);
    this.events.push({ type: 'equip', playerId: socketId, item: art.name });
    return true;
  }

  /** Retire l'artefact d'un emplacement et le remet dans l'inventaire. */
  unequip(socketId, slot) {
    const player = this.players.get(socketId);
    if (!player || !Classes.EQUIP_SLOTS.includes(slot)) return false;

    const type = player.equipment[slot];
    if (!type) return false;
    if (player.inventory.isFull()) {
      this.events.push({ type: 'notice', playerId: socketId, msg: 'Inventaire plein : impossible de déséquiper.' });
      return false;
    }

    player.equipment[slot] = null;
    player.inventory.add(type, 1);
    this.refreshAttrs(player);
    this.events.push({ type: 'equip', playerId: socketId, item: null });
    return true;
  }

  collectLoot(player) {
    if (player.state !== 'active') return;
    const now = Date.now();
    const reach = (player.attrs && player.attrs.pickup) || CONFIG.INVENTORY.pickupRadius;
    const luck = (player.attrs && player.attrs.luck) || 0;

    for (const item of this.ground.values()) {
      if (now < item.pickupAfter) continue;
      if (Math.hypot(item.x - player.x, item.y - player.y) > reach) continue;

      // Chance de la classe/des artefacts : un exemplaire de plus sur le meme ramassage.
      const qty = item.qty + (Math.random() < luck ? 1 : 0);
      const added = player.inventory.add(item.type, qty);
      if (added <= 0) {
        this.events.push({ type: 'full', playerId: player.id });
        continue;
      }

      this.ground.delete(item.id);
      player.stats.pickups = (player.stats.pickups || 0) + added;
      this.events.push({
        type: 'pickup',
        playerId: player.id,
        item: { type: item.type, qty: added, name: ITEMS[item.type].name }
      });
    }
  }

  // --- Simulation -------------------------------------------------------
  step(dt) {
    this.tick++;
    const now = Date.now();

    for (const player of this.players.values()) {
      if (player.state === 'dropping') {
        if (now >= player.dropUntil) player.state = 'active';
        player.pending.length = 0;
        continue;
      }

      // Budget de temps : un client ne peut pas envoyer plus de dt que le temps reel ecoule.
      player.dtBudget += ((now - player.lastBudgetAt) / 1000) * 1.15;
      player.lastBudgetAt = now;
      player.dtBudget = Math.min(player.dtBudget, 0.5);

      const from = { x: player.x, y: player.y };
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
      else player.stats.distance = Math.round((player.stats.distance || 0) + Math.hypot(player.x - from.x, player.y - from.y));

      this.collectLoot(player);
    }

    this.resolveOverlaps();

    if (now >= this.nextLootAt && this.count > 0) {
      this.nextLootAt = now + CONFIG.LOOT.spawnEveryMs;
      if (this.ground.size < CONFIG.LOOT.maxOnGround) this.spawnLoot();
    }
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

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        n: p.name,
        c: p.color,
        c2: p.tint,
        k: p.classId,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        a: Math.round(p.angle * 100) / 100,
        m: p.dx !== 0 || p.dy !== 0 ? 1 : 0,
        st: p.state === 'dropping' ? 1 : 0,
        seq: p.lastSeq
      });
    }

    const items = [];
    for (const it of this.ground.values()) {
      items.push({ id: it.id, t: it.type, x: Math.round(it.x), y: Math.round(it.y) });
    }

    return { t: Date.now(), tick: this.tick, players, items };
  }
}

module.exports = { Room, isValidType };
