// Chat multi-canaux facon Dofus : General (salle), Commerce et Recrutement
// (tout le serveur), Prive (chuchotement), Info (messages systeme).
// Le serveur reste autoritatif : c'est lui qui valide le canal, la cible,
// la longueur et la cadence. Le client n'est qu'une fenetre.
const CONFIG = require('./config');

const CHANNELS = {
  general: {
    id: 'general', label: 'Général', short: 'G', color: '#e6e3d8',
    scope: 'room', cmds: ['s', 'g'], hint: 'Les joueurs de ta salle'
  },
  commerce: {
    id: 'commerce', label: 'Commerce', short: 'C', color: '#ff9f43',
    scope: 'global', cmds: ['c'], hint: 'Tout le serveur — achats et ventes'
  },
  recrutement: {
    id: 'recrutement', label: 'Recrutement', short: 'R', color: '#4ecb8d',
    scope: 'global', cmds: ['r'], hint: 'Tout le serveur — groupes et guildes'
  },
  prive: {
    id: 'prive', label: 'Privé', short: 'P', color: '#ff7fe0',
    scope: 'private', cmds: ['w', 'm'], hint: 'Chuchotement à un seul joueur'
  },
  info: {
    id: 'info', label: 'Info', short: 'i', color: '#ffd15c',
    scope: 'system', cmds: [], hint: 'Messages du jeu'
  },
  erreur: {
    id: 'erreur', label: 'Erreur', short: '!', color: '#ff6b6b',
    scope: 'system', cmds: [], hint: 'Refus du serveur'
  }
};

// '/w' -> 'prive', '/c' -> 'commerce', ... : table construite une fois.
const COMMANDS = {};
for (const ch of Object.values(CHANNELS)) {
  for (const cmd of ch.cmds) COMMANDS[cmd] = ch.id;
}

/** Canaux dans lesquels un joueur peut ecrire (l'info est reservee au serveur). */
const SPEAKABLE = ['general', 'commerce', 'recrutement', 'prive'];

/** Catalogue envoye au client : il construit ses onglets et ses couleurs avec ca. */
function publicCatalog() {
  const out = {};
  for (const [id, ch] of Object.entries(CHANNELS)) {
    out[id] = {
      id, label: ch.label, short: ch.short, color: ch.color,
      scope: ch.scope, cmds: ch.cmds, hint: ch.hint,
      speakable: SPEAKABLE.includes(id)
    };
  }
  return out;
}

/** Nettoie un message : caracteres de controle, espaces multiples, longueur. */
function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, CONFIG.CHAT.maxLength);
}

class ChatManager {
  constructor(rooms) {
    this.rooms = rooms;
    this.roomHistory = new Map();  // roomId -> derniers messages de la salle
    this.globalHistory = [];       // commerce + recrutement, tout le serveur
    this.buckets = new Map();      // accountId -> etat anti-flood
    this.seq = 0;
  }

  // --- Anti-flood --------------------------------------------------------
  /**
   * Seau a jetons par compte : quelques messages d'affilee autorises, puis un
   * jeton se recharge toutes les CONFIG.CHAT.refillMs. Vide = silence temporaire.
   * Renvoie null si le message passe, sinon le motif du refus.
   */
  guard(accountId, text) {
    const now = Date.now();
    const b = this.buckets.get(accountId) || {
      tokens: CONFIG.CHAT.burst, last: now, mutedUntil: 0, lastText: '', repeats: 0
    };

    if (now < b.mutedUntil) {
      this.buckets.set(accountId, b);
      return `Tu parles trop vite — attends ${Math.ceil((b.mutedUntil - now) / 1000)} s.`;
    }

    b.tokens = Math.min(CONFIG.CHAT.burst, b.tokens + (now - b.last) / CONFIG.CHAT.refillMs);
    b.last = now;

    if (b.tokens < 1) {
      b.mutedUntil = now + CONFIG.CHAT.muteMs;
      b.tokens = 0;
      this.buckets.set(accountId, b);
      return `Flood détecté : chat coupé ${Math.round(CONFIG.CHAT.muteMs / 1000)} s.`;
    }

    // Repeter trois fois la meme phrase, c'est du spam aussi.
    if (text.toLowerCase() === b.lastText) {
      b.repeats += 1;
      if (b.repeats >= 2) {
        b.mutedUntil = now + CONFIG.CHAT.muteMs;
        this.buckets.set(accountId, b);
        return 'Message identique répété — laisse respirer le canal.';
      }
    } else {
      b.repeats = 0;
    }

    b.tokens -= 1;
    b.lastText = text.toLowerCase();
    this.buckets.set(accountId, b);
    return null;
  }

  // --- Historique --------------------------------------------------------
  remember(list, msg) {
    list.push(msg);
    while (list.length > CONFIG.CHAT.historySize) list.shift();
  }

  historyFor(roomId) {
    const local = this.roomHistory.get(roomId) || [];
    return [...local, ...this.globalHistory]
      .sort((a, b) => a.t - b.t)
      .slice(-CONFIG.CHAT.historySize);
  }

  /** Oublie les salles fermees et les compteurs des comptes deconnectes depuis longtemps. */
  prune() {
    const alive = new Set(this.rooms.all.map(r => r.id));
    for (const id of this.roomHistory.keys()) {
      if (!alive.has(id)) this.roomHistory.delete(id);
    }
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, b] of this.buckets) {
      if (b.last < cutoff) this.buckets.delete(key);
    }
  }

  // --- Envoi -------------------------------------------------------------
  /** Retrouve un joueur en jeu par son pseudo, quelle que soit sa salle. */
  findByName(name) {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return null;
    for (const room of this.rooms.all) {
      for (const [socketId, player] of room.players) {
        if (player.name.toLowerCase() === needle) return { socketId, player, room };
      }
    }
    return null;
  }

  message(fields) {
    return { id: ++this.seq, t: Date.now(), ...fields };
  }

  error(io, socketId, text) {
    io.to(socketId).emit('chat:message', this.message({
      ch: 'erreur', kind: 'system', text
    }));
  }

  /** Message systeme adresse a un joueur (ramassage, echange, avertissement). */
  notice(io, socketId, text) {
    io.to(socketId).emit('chat:message', this.message({
      ch: 'info', kind: 'system', text
    }));
  }

  /** Message systeme diffuse a toute une salle (arrivee, depart). */
  roomNotice(io, room, text) {
    const msg = this.message({ ch: 'info', kind: 'system', text });
    this.remember(this.roomHistory.get(room.id) || this.openRoom(room.id), msg);
    io.to(room.id).emit('chat:message', msg);
  }

  openRoom(roomId) {
    const list = [];
    this.roomHistory.set(roomId, list);
    return list;
  }

  /**
   * Point d'entree du client : { channel, text, to }.
   * Les commandes (/w pseudo, /c, /r) sont deja resolues cote client, mais on
   * accepte aussi une commande brute au cas ou elle arriverait telle quelle.
   */
  send(io, socketId, room, player, payload = {}) {
    let channel = String(payload.channel || 'general');
    let target = String(payload.to || '').trim();
    let text = sanitize(payload.text);

    // Repli : commande laissee dans le texte ("/w Bob salut").
    const raw = text.match(/^\/(\w+)\s*(.*)$/);
    if (raw && COMMANDS[raw[1].toLowerCase()]) {
      channel = COMMANDS[raw[1].toLowerCase()];
      text = raw[2];
      if (channel === 'prive') {
        const parts = text.match(/^(\S+)\s+(.*)$/);
        if (parts) { target = parts[1]; text = parts[2]; }
      }
      text = sanitize(text);
    }

    if (!SPEAKABLE.includes(channel)) return this.error(io, socketId, 'Canal inconnu.');
    if (!text) return;

    const refusal = this.guard(player.accountId, text);
    if (refusal) return this.error(io, socketId, refusal);

    const author = {
      from: player.name,
      fromId: socketId,
      classId: player.classId,
      color: player.color
    };

    if (channel === 'prive') {
      if (!target) return this.error(io, socketId, 'Usage : /w pseudo message');
      if (target.toLowerCase() === player.name.toLowerCase()) {
        return this.error(io, socketId, 'Te chuchoter à toi-même ? Va prendre l\'air.');
      }
      const found = this.findByName(target);
      if (!found) return this.error(io, socketId, `${target} n'est pas connecté.`);

      const msg = this.message({ ch: 'prive', kind: 'say', ...author, to: found.player.name, toId: found.socketId, text });
      io.to(found.socketId).emit('chat:message', msg);
      io.to(socketId).emit('chat:message', msg);   // l'expediteur voit son propre chuchotement
      return;
    }

    const kind = channel === 'general' && /^\/me\s+/i.test(text) ? 'emote' : 'say';
    const body = kind === 'emote' ? text.replace(/^\/me\s+/i, '') : text;
    if (!body) return;

    const msg = this.message({ ch: channel, kind, ...author, text: body });

    if (CHANNELS[channel].scope === 'global') {
      this.remember(this.globalHistory, msg);
      io.emit('chat:message', msg);               // commerce / recrutement : tout le serveur
    } else {
      const list = this.roomHistory.get(room.id) || this.openRoom(room.id);
      this.remember(list, msg);
      io.to(room.id).emit('chat:message', msg);   // general : la salle seulement
    }
  }
}

module.exports = { ChatManager, CHANNELS, COMMANDS, SPEAKABLE, publicCatalog, sanitize };
