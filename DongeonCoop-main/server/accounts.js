const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');

const CONFIG = require('./config');
const Store = require('./store');
const Inventory = require('./inventory');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SESSION_DAYS = 30;

const COLORS = [
  '#4ade80', '#38bdf8', '#f97316', '#c084fc',
  '#facc15', '#fb7185', '#2dd4bf', '#a3e635'
];

const USERNAME_RE = /^[\p{L}\p{N}_-]{3,14}$/u;

/**
 * Comptes joueurs : identifiants, mots de passe haches, et surtout l'etat
 * persistant (position, inventaire, statistiques) recharge a chaque connexion.
 */
class Accounts {
  constructor() {
    this.store = new Store(path.join(DATA_DIR, 'accounts.json'), { users: {}, secret: null }).autoFlush(2000);
    if (!this.store.data.users) this.store.data.users = {};

    // Secret de signature des jetons : persiste pour que les sessions survivent
    // a un redemarrage. Surchargeable par SESSION_SECRET en production.
    if (!this.store.data.secret) {
      this.store.data.secret = crypto.randomBytes(32).toString('hex');
      this.store.touch();
      this.store.flush();
    }
    this.secret = process.env.SESSION_SECRET || this.store.data.secret;
  }

  get users() {
    return this.store.data.users;
  }

  findByUsername(username) {
    const key = String(username || '').toLowerCase();
    return Object.values(this.users).find(u => u.username.toLowerCase() === key) || null;
  }

  async register(username, password) {
    const name = String(username || '').trim();
    if (!USERNAME_RE.test(name)) {
      return { error: 'Le pseudo doit faire 3 à 14 caractères (lettres, chiffres, - et _).' };
    }
    if (String(password || '').length < 6) {
      return { error: 'Le mot de passe doit faire au moins 6 caractères.' };
    }
    if (this.findByUsername(name)) {
      return { error: 'Ce pseudo est déjà pris.' };
    }

    const id = crypto.randomUUID();
    const user = {
      id,
      username: name,
      passHash: await bcrypt.hash(password, 10),
      color: COLORS[Object.keys(this.users).length % COLORS.length],
      createdAt: Date.now(),
      lastSeen: Date.now(),
      position: null,                       // null = depot sur l'anneau de spawn
      inventory: new Array(CONFIG.INVENTORY.slots).fill(null),
      stats: { playtimeMs: 0, pickups: 0, sessions: 0, distance: 0 }
    };

    this.users[id] = user;
    this.store.touch();
    this.store.flush();
    return { user, token: this.issueToken(user) };
  }

  async login(username, password) {
    const user = this.findByUsername(username);
    if (!user) return { error: 'Pseudo ou mot de passe incorrect.' };

    const ok = await bcrypt.compare(String(password || ''), user.passHash);
    if (!ok) return { error: 'Pseudo ou mot de passe incorrect.' };

    return { user, token: this.issueToken(user) };
  }

  // --- Jetons de session (HMAC, sans dependance externe) ---
  issueToken(user) {
    const expires = Date.now() + SESSION_DAYS * 86400000;
    const payload = `${user.id}.${expires}`;
    return `${payload}.${this.sign(payload)}`;
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;

    const [id, expires, sig] = parts;
    const expected = this.sign(`${id}.${expires}`);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Number(expires) < Date.now()) return null;

    return this.users[id] || null;
  }

  /** Etat charge a la connexion : position, inventaire, stats. */
  profile(user) {
    return {
      accountId: user.id,
      name: user.username,
      color: user.color,
      position: user.position,
      inventory: Inventory.sanitize(user.inventory),
      stats: user.stats || { playtimeMs: 0, pickups: 0, sessions: 0, distance: 0 }
    };
  }

  /** Sauvegarde de l'etat de jeu d'un joueur (appelee en autosave et a la deconnexion). */
  save(accountId, snapshot) {
    const user = this.users[accountId];
    if (!user) return false;

    if (snapshot.position) {
      user.position = {
        x: Math.round(snapshot.position.x * 100) / 100,
        y: Math.round(snapshot.position.y * 100) / 100,
        angle: Math.round(snapshot.position.angle * 1000) / 1000
      };
    }
    if (snapshot.inventory) user.inventory = Inventory.sanitize(snapshot.inventory);
    if (snapshot.stats) user.stats = { ...user.stats, ...snapshot.stats };
    user.lastSeen = Date.now();

    this.store.touch();
    return true;
  }

  markSession(accountId) {
    const user = this.users[accountId];
    if (!user) return;
    user.stats.sessions = (user.stats.sessions || 0) + 1;
    user.lastSeen = Date.now();
    this.store.touch();
  }

  flush() {
    this.store.flush();
  }
}

module.exports = Accounts;
