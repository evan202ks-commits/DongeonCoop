const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');

const CONFIG = require('./config');
const Store = require('./store');
const Inventory = require('./inventory');
const Classes = require('./classes');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SESSION_DAYS = 30;

const COLORS = [
  '#4ade80', '#38bdf8', '#f97316', '#c084fc',
  '#facc15', '#fb7185', '#2dd4bf', '#a3e635'
];

const USERNAME_RE = /^[\p{L}\p{N}_-]{3,14}$/u;

const emptyStats = () => ({ playtimeMs: 0, pickups: 0, sessions: 0, distance: 0 });

/**
 * Comptes joueurs : identifiants, mots de passe haches, et l'etat persistant.
 *
 * L'etat de jeu n'est PAS stocke sur le compte mais sur chaque classe du compte :
 * un joueur choisit sa classe a chaque connexion et retrouve la position,
 * l'inventaire, l'equipement et les statistiques propres a cette classe.
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

    for (const user of Object.values(this.users)) Accounts.migrate(user);
    this.store.touch();
    this.store.flush();
  }

  get users() {
    return this.store.data.users;
  }

  /** Comptes d'avant les classes : l'ancien etat unique devient un heritage a reprendre. */
  static migrate(user) {
    if (!user.classes) user.classes = {};
    if (user.lastClass === undefined) user.lastClass = null;

    // La bourse est au compte, pas au personnage : l'or gagne avec un Mage
    // reste depensable avec un Voleur. Les comptes d'avant l'hotel de vente
    // recoivent la mise de depart.
    if (typeof user.gold !== 'number' || !Number.isFinite(user.gold)) {
      user.gold = CONFIG.MARKET.startingGold;
    }
    user.gold = Math.max(0, Math.floor(user.gold));

    const hasLegacyRoot = 'position' in user || 'inventory' in user;
    if (hasLegacyRoot && !user.legacy) {
      user.legacy = {
        position: user.position || null,
        inventory: Array.isArray(user.inventory) ? user.inventory : null,
        stats: user.stats || null
      };
    }
    delete user.position;
    delete user.inventory;
    delete user.stats;
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
      gold: CONFIG.MARKET.startingGold,
      lastClass: null,      // aucune classe jouee : l'ecran de choix part vierge
      classes: {}           // rempli a la premiere partie de chaque classe
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

    Accounts.migrate(user);
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

  // --- Etat par classe ----------------------------------------------------
  /**
   * Cree la fiche de classe a la premiere partie : ses artefacts lui sont
   * attribues d'office dans son inventaire, prets a etre equipes.
   * Si le compte vient d'avant les classes, son ancien etat est repris ici.
   */
  ensureClass(user, classId) {
    if (!user.classes) user.classes = {};
    if (user.classes[classId]) {
      Accounts.repairClass(classId, user.classes[classId]);
      return user.classes[classId];
    }

    const state = {
      position: null,                    // null = depot sur un point de la salle
      inventory: new Array(CONFIG.INVENTORY.slots).fill(null),
      equipment: Classes.emptyEquipment(),
      stats: emptyStats(),
      createdAt: Date.now()
    };

    // Heritage : le premier personnage cree recupere l'etat d'avant les classes.
    if (user.legacy) {
      if (user.legacy.position) state.position = user.legacy.position;
      if (Array.isArray(user.legacy.inventory)) state.inventory = user.legacy.inventory;
      if (user.legacy.stats) state.stats = { ...state.stats, ...user.legacy.stats };
      delete user.legacy;
    }

    Accounts.repairClass(classId, state);
    user.classes[classId] = state;
    this.store.touch();
    return state;
  }

  /**
   * Remet en ordre une fiche de classe : inventaire et equipement nettoyes,
   * et surtout tout artefact de la classe absent des deux est redonne
   * (garantit qu'un personnage possede toujours ses artefacts).
   */
  static repairClass(classId, state) {
    state.equipment = Classes.sanitizeEquipment(classId, state.equipment);
    const inv = new Inventory(state.inventory);

    for (const art of Classes.artifactsOf(classId)) {
      const equipped = state.equipment[art.slot] === art.id;
      if (equipped || inv.has(art.id)) continue;
      if (inv.add(art.id, 1) === 0) state.equipment[art.slot] = art.id; // inventaire plein : on l'equipe
    }

    // Artefacts d'une autre classe glisses dans l'inventaire : ecartes.
    const slots = inv.toJSON();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s && Classes.isArtifact(s.type) && Classes.ARTIFACTS[s.type].classId !== classId) slots[i] = null;
    }

    state.inventory = slots;
    if (!state.stats) state.stats = emptyStats();
    return state;
  }

  // --- Bourse -------------------------------------------------------------
  // L'or ne transite jamais par l'inventaire : il vit sur le compte, donc un
  // vendeur deconnecte est paye quand meme. C'est ici la source de verite.
  gold(accountId) {
    const user = this.users[accountId];
    return user ? Math.max(0, Math.floor(user.gold || 0)) : 0;
  }

  addGold(accountId, amount) {
    const user = this.users[accountId];
    const n = Math.floor(Number(amount) || 0);
    if (!user || n <= 0) return this.gold(accountId);
    user.gold = this.gold(accountId) + n;
    this.store.touch();
    return user.gold;
  }

  /** Debite si le compte a de quoi payer. Renvoie false sans rien changer sinon. */
  spendGold(accountId, amount) {
    const user = this.users[accountId];
    const n = Math.floor(Number(amount) || 0);
    if (!user || n <= 0 || this.gold(accountId) < n) return false;
    user.gold = this.gold(accountId) - n;
    this.store.touch();
    return true;
  }

  // --- Profils ------------------------------------------------------------
  /** Vue compte : sert a l'ecran de choix de classe (progression de chaque personnage). */
  profile(user) {
    const classes = {};
    for (const id of Classes.CLASS_IDS) {
      const state = user.classes && user.classes[id];
      classes[id] = state
        ? {
            played: true,
            stats: state.stats || emptyStats(),
            equipment: Classes.sanitizeEquipment(id, state.equipment),
            filled: Inventory.sanitize(state.inventory).filter(Boolean).length
          }
        : { played: false, stats: emptyStats(), equipment: Classes.emptyEquipment(), filled: 0 };
    }

    return {
      accountId: user.id,
      name: user.username,
      color: user.color,
      lastClass: user.lastClass || null,
      createdAt: user.createdAt,
      gold: this.gold(user.id),
      classes
    };
  }

  /** Vue partie : etat charge a l'entree en jeu, pour la classe choisie. */
  gameProfile(user, classId) {
    const state = this.ensureClass(user, classId);
    return {
      accountId: user.id,
      name: user.username,
      color: user.color,
      classId,
      gold: this.gold(user.id),
      position: state.position,
      inventory: Inventory.sanitize(state.inventory),
      equipment: Classes.sanitizeEquipment(classId, state.equipment),
      stats: state.stats || emptyStats()
    };
  }

  /** Sauvegarde de l'etat de jeu d'un personnage (autosave et deconnexion). */
  save(accountId, classId, snapshot) {
    const user = this.users[accountId];
    if (!user || !Classes.isValidClass(classId)) return false;
    const state = this.ensureClass(user, classId);

    if (snapshot.position) {
      state.position = {
        x: Math.round(snapshot.position.x * 100) / 100,
        y: Math.round(snapshot.position.y * 100) / 100,
        angle: Math.round(snapshot.position.angle * 1000) / 1000
      };
    }
    if (snapshot.inventory) state.inventory = Inventory.sanitize(snapshot.inventory);
    if (snapshot.equipment) state.equipment = Classes.sanitizeEquipment(classId, snapshot.equipment);
    if (snapshot.stats) state.stats = { ...state.stats, ...snapshot.stats };
    user.lastSeen = Date.now();

    this.store.touch();
    return true;
  }

  markSession(accountId, classId) {
    const user = this.users[accountId];
    if (!user) return;
    const state = this.ensureClass(user, classId);
    state.stats.sessions = (state.stats.sessions || 0) + 1;
    user.lastClass = classId;
    user.lastSeen = Date.now();
    this.store.touch();
  }

  flush() {
    this.store.flush();
  }
}

module.exports = Accounts;
