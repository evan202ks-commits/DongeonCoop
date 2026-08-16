const crypto = require('crypto');
const CONFIG = require('./config');
const Inventory = require('./inventory');
const { ITEMS, isDroppable } = require('./items');

/**
 * Echanges d'objets entre deux comptes connectes, quelle que soit leur classe
 * ou leur personnage : seul compte le fait que les deux joueurs soient sur le
 * meme terrain et proches l'un de l'autre au moment de la demande.
 *
 * Comme pour le sol (server/Room.js), les artefacts de classe ne sont jamais
 * echangeables : ils sont lies au personnage qui les a recus, pas au compte.
 * Seuls les objets de butin ordinaires (server/items.js LOOT) changent de sac.
 *
 * Un joueur n'a qu'une seule negociation active a la fois (demande emise,
 * demande recue, ou echange en cours).
 */
class TradeManager {
  constructor(rooms) {
    this.rooms = rooms;
    this.pending = new Map(); // socketId cible -> { fromId, timer }
    this.trades = new Map();  // socketId -> session (les deux cotes partagent le meme objet)
  }

  // --- Recherche -----------------------------------------------------------
  findPlayer(socketId) {
    for (const room of this.rooms.all) {
      const player = room.players.get(socketId);
      if (player) return { room, player };
    }
    return null;
  }

  isBusy(socketId) {
    if (this.trades.has(socketId) || this.pending.has(socketId)) return true;
    for (const req of this.pending.values()) {
      if (req.fromId === socketId) return true;
    }
    return false;
  }

  // --- Demande ---------------------------------------------------------
  request(io, fromId, toId) {
    if (!toId || fromId === toId) return this.error(io, fromId, "Choisis un autre joueur à échanger.");

    const from = this.findPlayer(fromId);
    const to = this.findPlayer(toId);
    if (!from || !to) return this.error(io, fromId, 'Ce joueur a quitté le terrain.');
    if (from.room !== to.room) return this.error(io, fromId, "Ce joueur n'est pas sur le même terrain.");

    const dist = Math.hypot(from.player.x - to.player.x, from.player.y - to.player.y);
    if (dist > CONFIG.TRADE.requestRange) {
      return this.error(io, fromId, 'Rapproche-toi pour proposer un échange.');
    }
    if (this.isBusy(fromId)) return this.error(io, fromId, 'Termine ta négociation en cours avant d\'en démarrer une autre.');
    if (this.isBusy(toId)) return this.error(io, fromId, `${to.player.name} est déjà occupé.`);

    const timer = setTimeout(() => {
      const req = this.pending.get(toId);
      if (!req || req.fromId !== fromId) return;
      this.pending.delete(toId);
      this.error(io, fromId, `${to.player.name} n'a pas répondu à temps.`);
      io.to(toId).emit('trade:cancelled', { reason: 'Demande expirée.' });
    }, CONFIG.TRADE.requestTimeoutMs);

    this.pending.set(toId, { fromId, timer });
    io.to(toId).emit('trade:incoming', {
      fromId, fromName: from.player.name, fromClassId: from.player.classId
    });
    io.to(fromId).emit('trade:notice', `Demande d'échange envoyée à ${to.player.name}.`);
  }

  respond(io, toId, accept) {
    const req = this.pending.get(toId);
    if (!req) return;
    clearTimeout(req.timer);
    this.pending.delete(toId);

    const from = this.findPlayer(req.fromId);
    const to = this.findPlayer(toId);
    if (!from || !to) return;

    if (!accept) {
      io.to(req.fromId).emit('trade:cancelled', { reason: `${to.player.name} a refusé l'échange.` });
      return;
    }
    if (this.isBusy(req.fromId) || this.isBusy(toId)) {
      io.to(req.fromId).emit('trade:cancelled', { reason: 'Échange déjà indisponible.' });
      return;
    }

    const session = {
      id: crypto.randomBytes(6).toString('hex'),
      players: [req.fromId, toId],
      sides: {
        [req.fromId]: { offer: new Map(), confirmed: false },
        [toId]: { offer: new Map(), confirmed: false }
      }
    };
    this.trades.set(req.fromId, session);
    this.trades.set(toId, session);

    this.broadcast(io, session, 'trade:start');
  }

  // --- Offre ---------------------------------------------------------------
  /** Fixe la quantite offerte d'un type d'objet (0 = retire ce type de l'offre). */
  setOffer(io, socketId, type, qty) {
    const session = this.trades.get(socketId);
    if (!session) return;

    const found = this.findPlayer(socketId);
    if (!found) return this.cancel(io, socketId, 'Le joueur a quitté le terrain.');

    if (!isDroppable(type)) {
      return this.error(io, socketId, "Cet objet ne peut pas être échangé.");
    }

    const side = session.sides[socketId];
    const have = found.player.inventory.count(type);
    const clamped = Math.max(0, Math.min(Math.floor(Number(qty) || 0), have));

    if (clamped <= 0) {
      side.offer.delete(type);
    } else {
      if (!side.offer.has(type) && side.offer.size >= CONFIG.TRADE.maxOfferTypes) {
        return this.error(io, socketId, `Maximum ${CONFIG.TRADE.maxOfferTypes} types d'objets par échange.`);
      }
      side.offer.set(type, clamped);
    }

    // Modifier son offre invalide les deux confirmations : il faut revalider.
    for (const id of session.players) session.sides[id].confirmed = false;
    this.broadcast(io, session, 'trade:update');
  }

  confirm(io, socketId) {
    const session = this.trades.get(socketId);
    if (!session) return;
    session.sides[socketId].confirmed = true;
    this.broadcast(io, session, 'trade:update');

    const [a, b] = session.players;
    if (session.sides[a].confirmed && session.sides[b].confirmed) {
      this.finalize(io, session);
    }
  }

  cancel(io, socketId, reason = 'Échange annulé.') {
    const session = this.trades.get(socketId);
    if (!session) return;
    for (const id of session.players) {
      this.trades.delete(id);
      io.to(id).emit('trade:cancelled', { reason });
    }
  }

  /** A appeler a la deconnexion ou au depart de salle d'un joueur. */
  handleLeave(io, socketId) {
    const own = this.pending.get(socketId);
    if (own) { clearTimeout(own.timer); this.pending.delete(socketId); }

    for (const [targetId, req] of this.pending) {
      if (req.fromId !== socketId) continue;
      clearTimeout(req.timer);
      this.pending.delete(targetId);
      io.to(targetId).emit('trade:cancelled', { reason: 'Le joueur a quitté le terrain.' });
    }

    if (this.trades.has(socketId)) this.cancel(io, socketId, 'Le joueur a quitté le terrain.');
  }

  // --- Finalisation ----------------------------------------------------
  finalize(io, session) {
    const [aId, bId] = session.players;
    const a = this.findPlayer(aId);
    const b = this.findPlayer(bId);
    for (const id of session.players) this.trades.delete(id);

    if (!a || !b) {
      const alive = a ? aId : (b ? bId : null);
      if (alive) io.to(alive).emit('trade:cancelled', { reason: "L'autre joueur a quitté le terrain." });
      return;
    }

    const offerA = session.sides[aId].offer;
    const offerB = session.sides[bId].offer;

    // Revalidation finale : l'inventaire a pu changer depuis la derniere offre
    // (ramassage, jet au sol, autre echange). On annule plutot que de tricher.
    for (const [type, qty] of offerA) {
      if (a.player.inventory.count(type) < qty) {
        return this.abort(io, session, `L'offre de ${a.player.name} n'est plus valide.`);
      }
    }
    for (const [type, qty] of offerB) {
      if (b.player.inventory.count(type) < qty) {
        return this.abort(io, session, `L'offre de ${b.player.name} n'est plus valide.`);
      }
    }

    // Simulation a blanc : chacun doit avoir la place pour ce qu'il recoit,
    // une fois son propre don retire de son sac.
    const simA = new Inventory(a.player.inventory.toJSON());
    for (const [type, qty] of offerA) for (let i = 0; i < qty; i++) simA.removeType(type);
    for (const [type, qty] of offerB) {
      if (simA.add(type, qty) < qty) return this.abort(io, session, `Le sac de ${a.player.name} est trop plein pour recevoir l'échange.`);
    }

    const simB = new Inventory(b.player.inventory.toJSON());
    for (const [type, qty] of offerB) for (let i = 0; i < qty; i++) simB.removeType(type);
    for (const [type, qty] of offerA) {
      if (simB.add(type, qty) < qty) return this.abort(io, session, `Le sac de ${b.player.name} est trop plein pour recevoir l'échange.`);
    }

    // Application reelle : retrait des deux cotes, puis remise croisee.
    for (const [type, qty] of offerA) for (let i = 0; i < qty; i++) a.player.inventory.removeType(type);
    for (const [type, qty] of offerB) for (let i = 0; i < qty; i++) b.player.inventory.removeType(type);
    for (const [type, qty] of offerB) a.player.inventory.add(type, qty);
    for (const [type, qty] of offerA) b.player.inventory.add(type, qty);

    a.room.refreshAttrs(a.player);
    b.room.refreshAttrs(b.player);

    const summarize = (offer) => [...offer].map(([type, qty]) => ({ type, qty, name: ITEMS[type].name }));

    io.to(aId).emit('trade:done', { gave: summarize(offerA), received: summarize(offerB), withName: b.player.name });
    io.to(bId).emit('trade:done', { gave: summarize(offerB), received: summarize(offerA), withName: a.player.name });

    io.to(aId).emit('inventory', {
      slots: a.player.inventory.toJSON(), equipment: a.player.equipment,
      attrs: a.player.attrs, stats: a.player.stats
    });
    io.to(bId).emit('inventory', {
      slots: b.player.inventory.toJSON(), equipment: b.player.equipment,
      attrs: b.player.attrs, stats: b.player.stats
    });
  }

  abort(io, session, reason) {
    for (const id of session.players) io.to(id).emit('trade:cancelled', { reason });
  }

  // --- Diffusion -------------------------------------------------------
  broadcast(io, session, eventName) {
    const [aId, bId] = session.players;
    const a = this.findPlayer(aId);
    const b = this.findPlayer(bId);

    const view = (selfId, otherId, other) => ({
      yourOffer: [...session.sides[selfId].offer].map(([type, qty]) => ({ type, qty })),
      theirOffer: [...session.sides[otherId].offer].map(([type, qty]) => ({ type, qty })),
      youConfirmed: session.sides[selfId].confirmed,
      theyConfirmed: session.sides[otherId].confirmed,
      otherId,
      otherName: other ? other.player.name : '?',
      otherClassId: other ? other.player.classId : null
    });

    io.to(aId).emit(eventName, view(aId, bId, b));
    io.to(bId).emit(eventName, view(bId, aId, a));
  }

  error(io, socketId, msg) {
    io.to(socketId).emit('trade:error', msg);
  }
}

module.exports = TradeManager;
