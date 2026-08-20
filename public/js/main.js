import { Auth } from './auth.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Renderer } from './render.js';
import { Collision } from './collision.js';
import { Chat } from './chat.js';

const net = new Net();
const input = new Input();
const chat = new Chat();
let renderer = null;
let collision = null;          // grille de collision de la salle (recue avec la config)

const INPUT_STEP = 1 / 30;      // 30 commandes / seconde envoyees au serveur
let inputAcc = 0;
let seq = 0;
let pending = [];               // commandes non encore confirmees par le serveur

const self = { x: 0, y: 0, angle: 0, name: '', color: '#4ade80', speed: 260 };
const dropStarts = new Map();   // id -> debut de chute (pour l'animation)
let inventory = [];
let equipment = {};
let catalog = null;             // { classes, slots, labels }
let account = null;             // profil compte : progression de chaque classe
let joined = false;
let doorAt = 0;                 // horodatage serveur du dernier declenchement de la porte
let doorReachable = false;      // le joueur est-il devant le mecanisme ?
let mode = 'login';
let lastFrame = performance.now();

// --- Echanges entre comptes ---
let incomingTrade = null;   // { fromId, fromName } en attente de reponse
let activeTrade = null;     // { otherId, otherName, yourOffer, theirOffer, youConfirmed, theyConfirmed }

const el = (id) => document.getElementById(id);

// --- Simulation locale : doit rester identique a Room.applyInput cote serveur ---
function applyInput(entity, cmd, config) {
  let { ax, ay } = cmd;
  const len = Math.hypot(ax, ay);
  if (len > 1) { ax /= len; ay /= len; }

  // La vitesse depend de la classe et des artefacts equipes, pas de CONFIG.
  const speed = entity.speed || config.PLAYER.speed;
  const r = config.PLAYER.radius;

  if (collision) {
    // Memes murs que le serveur : sans ca, la prediction traverse le mobilier
    // puis se fait ramener en arriere a chaque snapshot.
    collision.move(entity, ax * speed * cmd.dt, ay * speed * cmd.dt, r);
  } else {
    entity.x += ax * speed * cmd.dt;
    entity.y += ay * speed * cmd.dt;
    entity.x = Math.max(r, Math.min(config.WORLD.width - r, entity.x));
    entity.y = Math.max(r, Math.min(config.WORLD.height - r, entity.y));
  }

  if (len > 0.01) entity.angle = Math.atan2(ay, ax);
}

// --- Ecran de connexion ------------------------------------------------
function setMode(next) {
  mode = next;
  el('tabLogin').classList.toggle('active', next === 'login');
  el('tabRegister').classList.toggle('active', next === 'register');
  el('submitBtn').textContent = next === 'login' ? 'Se connecter' : 'Créer le compte';
  el('password').setAttribute('autocomplete', next === 'login' ? 'current-password' : 'new-password');
  el('authError').textContent = '';
}

async function submit() {
  const username = el('username').value.trim();
  const password = el('password').value;
  const btn = el('submitBtn');

  btn.disabled = true;
  el('authError').textContent = '';
  try {
    const profile = mode === 'login'
      ? await Auth.login(username, password)
      : await Auth.register(username, password);
    btn.disabled = false;
    btn.textContent = mode === 'login' ? 'Se connecter' : 'Créer le compte';
    // Creation de compte comme simple connexion : on passe par le choix de classe.
    await showClassGate(profile);
  } catch (err) {
    el('authError').textContent = err.message;
    btn.disabled = false;
  }
}

// --- Choix de la classe (a chaque connexion) ---------------------------
const fmtTime = (ms) => {
  const min = Math.round((ms || 0) / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
};

async function showClassGate(profile) {
  account = profile;
  if (!catalog) catalog = await Auth.classes();

  el('gate').classList.add('hidden');
  el('classGate').hidden = false;
  el('classIntro').textContent = profile.lastClass
    ? `Content de te revoir, ${profile.name}. Reprends un personnage ou lances-en un autre.`
    : `Bienvenue ${profile.name}. Chaque classe garde son propre inventaire, ses artefacts et sa progression.`;

  const grid = el('classGrid');
  grid.innerHTML = '';

  for (const cls of Object.values(catalog.classes)) {
    const state = (profile.classes && profile.classes[cls.id]) || { played: false, stats: {}, equipment: {}, filled: 0 };

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'class-card';
    card.style.setProperty('--cls', cls.color);
    if (profile.lastClass === cls.id) card.classList.add('last');

    const equippedCount = catalog.slots.filter(s => state.equipment && state.equipment[s]).length;

    card.innerHTML = `
      <div class="class-head">
        <span class="class-dot"></span>
        <span class="class-name">${cls.name}</span>
        ${profile.lastClass === cls.id ? '<span class="class-tag">dernier joué</span>' : ''}
      </div>
      <p class="class-tagline">${cls.tagline}</p>
      <div class="class-base">
        <span>Vitesse <b>${cls.base.speed}</b></span>
        <span>Portée <b>${cls.base.pickup}</b></span>
        <span>Chance <b>${Math.round(cls.base.luck * 100)}%</b></span>
      </div>
      <div class="class-arts">
        ${cls.artifacts.map(a => `
          <div class="class-art" title="${a.desc}">
            <i style="background:${a.color}"></i>
            <span class="art-name">${a.name}</span>
            <span class="art-slot">${catalog.labels[a.slot]}</span>
          </div>`).join('')}
      </div>
      <div class="class-progress">${state.played
        ? `${state.stats.sessions || 0} session(s) · ${state.stats.pickups || 0} ramassés · ${fmtTime(state.stats.playtimeMs)} · ${equippedCount}/${catalog.slots.length} équipé(s)`
        : 'Nouveau personnage — ses 3 artefacts t\u2019attendent dans son sac.'}</div>
    `;
    card.addEventListener('click', () => enterGame(cls.id));
    grid.appendChild(card);
  }
}

function enterGame(classId) {
  el('classGate').hidden = true;
  net.connect(Auth.token, classId);
}

/** Session encore valide : on saute la saisie du mot de passe, pas le choix de classe. */
async function boot() {
  const profile = await Auth.resume();
  if (profile) {
    el('logoutBtn').hidden = false;
    await showClassGate(profile);
  }
}

// --- Reception du serveur ----------------------------------------------
net.onWelcome = (data) => {
  self.x = data.you.x;
  self.y = data.you.y;
  self.angle = data.you.angle;
  self.name = data.you.name;
  self.color = data.you.color;
  self.speed = data.you.attrs.speed;
  inventory = data.inventory || [];
  equipment = data.equipment || {};
  catalog = catalog || { classes: data.classes, slots: data.equipSlots, labels: data.slotLabels };
  dropStarts.set(data.id, performance.now());

  collision = new Collision(data.config.MAP);
  renderer = new Renderer(el('stage'), data.config, data.items, data.classes);
  // Un joueur qui arrive pendant la sequence la reprend en cours de route.
  doorAt = (data.door && data.door.at) || 0;
  renderer.centerOn(self.x, self.y);

  el('roomId').textContent = data.roomId;
  el('pickups').textContent = data.you.stats?.pickups || 0;
  el('classLabel').textContent = catalog.classes[data.you.classId].name;
  el('gate').classList.add('hidden');
  el('classGate').hidden = true;

  // Le chat n'existe qu'une fois en jeu : il a besoin du catalogue de canaux
  // et de savoir qui est "moi" pour distinguer les chuchotements envoyes/recus.
  chat.setup({
    channels: data.channels,
    selfId: data.id,
    selfName: data.you.name,
    bubbleMs: data.config.CHAT.bubbleMs,
    onSend: (payload) => net.sendChat(payload)
  });
  chat.replay(data.chatHistory);

  drawInventory();
  drawEquipment();
  drawAttrs(data.you.attrs);

  joined = true;
  rosterSignature = ''; // force la reconstruction du roster pour la nouvelle session
  log(data.you.restored
    ? `${catalog.classes[data.you.classId].name} repris là où tu t'étais arrêté.`
    : `${self.name} entre sur le terrain en ${catalog.classes[data.you.classId].name}.`);
  requestAnimationFrame(loop);
};

net.onChat = (msg) => chat.push(msg);

net.onInventory = (data) => {
  inventory = data.slots;
  if (data.equipment) equipment = data.equipment;
  if (data.attrs) { self.speed = data.attrs.speed; drawAttrs(data.attrs); }
  drawInventory();
  drawEquipment();
  if (data.picked) log(`+${data.picked.qty} ${data.picked.name}`);
  if (data.equipped) log(`${data.equipped} équipé.`);
  if (data.stats) el('pickups').textContent = data.stats.pickups || 0;
  if (activeTrade) drawTrade(); // le sac affiché dans l'echange doit rester a jour
};

net.onEvent = (type, payload) => {
  if (type === 'door') doorAt = payload.at;
  // Les arrivees et departs remontent deja par le canal Info du serveur.
  if (type === 'notice') log(payload.msg);
  if (type === 'disconnect') log('Connexion perdue — reconnexion…');
  if (type === 'auth-error') {
    joined = false;
    doorReachable = false;
    el('doorBtn').hidden = true;
    el('classGate').hidden = true;
    el('gate').classList.remove('hidden');
    el('submitBtn').disabled = false;
    el('submitBtn').textContent = mode === 'login' ? 'Se connecter' : 'Créer le compte';
    el('authError').textContent = payload.msg;
  }
};

net.onTrade = (type, data) => {
  if (type === 'incoming') {
    incomingTrade = { fromId: data.fromId, fromName: data.fromName };
    el('tradeIncomingName').textContent = data.fromName;
    el('tradeIncoming').hidden = false;
  } else if (type === 'start' || type === 'update') {
    incomingTrade = null;
    el('tradeIncoming').hidden = true;
    activeTrade = {
      otherId: data.otherId, otherName: data.otherName,
      yourOffer: data.yourOffer, theirOffer: data.theirOffer,
      youConfirmed: data.youConfirmed, theyConfirmed: data.theyConfirmed
    };
    drawTrade();
  } else if (type === 'cancelled') {
    activeTrade = null;
    incomingTrade = null;
    el('tradeIncoming').hidden = true;
    el('tradeModal').hidden = true;
    log(data.reason || 'Échange annulé.');
  } else if (type === 'done') {
    activeTrade = null;
    el('tradeModal').hidden = true;
    const gave = data.gave.map(i => `${i.qty} ${i.name}`).join(', ') || 'rien';
    const got = data.received.map(i => `${i.qty} ${i.name}`).join(', ') || 'rien';
    log(`Échange conclu avec ${data.withName} : donné ${gave} — reçu ${got}.`);
  } else if (type === 'error') {
    log(data.msg);
  } else if (type === 'notice') {
    log(data.msg);
  }
};

/** Reconstruit la fenetre d'echange a partir de l'etat local (offre + sac courant). */
function drawTrade() {
  if (!activeTrade) return;
  const t = activeTrade;
  el('tradeModal').hidden = false;
  el('tradeWithName').textContent = t.otherName;
  el('tradeOtherName2').textContent = t.otherName;

  const renderList = (target, items, opts) => {
    target.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'trade-empty';
      empty.textContent = opts.emptyText;
      target.appendChild(empty);
      return;
    }
    for (const entry of items) {
      const def = itemDef(entry.type);
      const row = document.createElement('div');
      row.className = 'trade-item' + (opts.onClick ? ' actionable' : '');
      row.title = opts.onClick ? opts.title : '';

      const gem = document.createElement('div');
      gem.className = 'gem';
      styleGem(gem, def);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = def.name;

      const qty = document.createElement('span');
      qty.className = 'qty';
      qty.textContent = `×${entry.qty}`;

      row.append(gem, name, qty);
      if (opts.onClick) row.addEventListener('click', () => opts.onClick(entry));
      target.appendChild(row);
    }
  };

  // Ton offre : clic pour en retirer un exemplaire.
  renderList(el('tradeYourOffer'), t.yourOffer, {
    emptyText: 'Rien proposé pour l\u2019instant.',
    title: 'Clic pour retirer 1',
    onClick: (entry) => net.tradeOffer(entry.type, entry.qty - 1)
  });

  // Offre de l'autre joueur : lecture seule.
  renderList(el('tradeTheirOffer'), t.theirOffer, {
    emptyText: 'Rien proposé pour l\u2019instant.'
  });

  // Ton sac : uniquement les objets echangeables (les artefacts de classe ne le sont pas),
  // avec la quantite deja mise dans l'offre soustraite de ce qui reste disponible.
  const offered = new Map(t.yourOffer.map(e => [e.type, e.qty]));
  const counts = new Map();
  for (const slot of inventory) {
    if (!slot) continue;
    const def = itemDef(slot.type);
    if (def.artifact) continue;
    counts.set(slot.type, (counts.get(slot.type) || 0) + slot.qty);
  }
  const bag = [...counts.entries()]
    .map(([type, total]) => ({ type, qty: total - (offered.get(type) || 0) }))
    .filter(e => e.qty > 0);

  renderList(el('tradeYourBag'), bag, {
    emptyText: 'Sac vide (hors artefacts).',
    title: 'Clic pour ajouter 1 à l\u2019offre',
    onClick: (entry) => net.tradeOffer(entry.type, (offered.get(entry.type) || 0) + 1)
  });

  const btn = el('tradeConfirmBtn');
  btn.textContent = t.youConfirmed ? 'Offre validée ✓' : 'Valider mon offre';
  btn.classList.toggle('confirmed', t.youConfirmed);

  el('tradeStatus').textContent = t.youConfirmed && t.theyConfirmed
    ? 'Échange en cours…'
    : t.youConfirmed
      ? `En attente de ${t.otherName}…`
      : t.theyConfirmed
        ? `${t.otherName} a validé son offre.`
        : 'Compose ton offre puis valide-la.';
}

/** Toutes les nouvelles du jeu (butin, echanges, reseau) tombent dans le canal Info. */
function log(message) {
  chat.system(message);
}

// --- Inventaire et equipement ------------------------------------------
const itemDef = (type) => net.items[type] || { color: '#94a3b8', name: type };

/** Habille un ".gem" (sac, equipement, echange) : icone si disponible, sinon aplat de couleur. */
function styleGem(gem, def) {
  if (def.icon) {
    gem.classList.add('icon');
    gem.style.backgroundColor = 'transparent';
    gem.style.backgroundImage = `url(${def.icon})`;
  } else {
    gem.classList.remove('icon');
    gem.style.backgroundImage = 'none';
    gem.style.background = def.color;
  }
}

function drawInventory() {
  const grid = el('slots');
  const size = net.config ? net.config.INVENTORY.slots : inventory.length;
  grid.innerHTML = '';

  for (let i = 0; i < size; i++) {
    const slot = inventory[i];
    const cell = document.createElement('div');
    cell.className = slot ? 'slot filled' : 'slot';

    if (slot) {
      const def = itemDef(slot.type);
      const isArtifact = !!def.artifact;
      if (isArtifact) cell.classList.add('artifact');
      cell.title = isArtifact
        ? `${def.name} — ${def.desc} — clic pour équiper`
        : `${def.name} ×${slot.qty} — clic pour en jeter un`;

      const gem = document.createElement('div');
      gem.className = 'gem';
      styleGem(gem, def);
      cell.appendChild(gem);

      if (slot.qty > 1) {
        const qty = document.createElement('span');
        qty.className = 'qty';
        qty.textContent = slot.qty;
        cell.appendChild(qty);
      }
      // Un artefact s'equipe, tout le reste se jette : un seul clic pour les deux.
      cell.addEventListener('click', () => isArtifact ? net.equip(slot.type) : net.dropSlot(i));
    }
    grid.appendChild(cell);
  }
}

function drawEquipment() {
  const wrap = el('equip');
  if (!catalog) return;
  wrap.innerHTML = '';

  for (const slotName of catalog.slots) {
    const type = equipment[slotName];
    const cell = document.createElement('div');
    cell.className = type ? 'eq filled' : 'eq';

    const label = document.createElement('span');
    label.className = 'eq-label';
    label.textContent = catalog.labels[slotName];
    cell.appendChild(label);

    if (type) {
      const def = itemDef(type);
      const gem = document.createElement('div');
      gem.className = 'gem';
      styleGem(gem, def);
      cell.appendChild(gem);
      cell.title = `${def.name} — ${def.desc} — clic pour déséquiper`;
      cell.addEventListener('click', () => net.unequip(slotName));
    } else {
      cell.title = `${catalog.labels[slotName]} — aucun artefact équipé`;
    }
    wrap.appendChild(cell);
  }
}

function drawAttrs(attrs) {
  el('attrs').textContent = `Vitesse ${attrs.speed} · Portée ${attrs.pickup} · Chance ${Math.round(attrs.luck * 100)}%`;
}

// --- Boucle de rendu ---------------------------------------------------
function loop(now) {
  requestAnimationFrame(loop);
  if (!joined || !net.config) return;

  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (!isDropping(net.id)) sendInputs(dt);
  reconcile();

  const players = buildPlayerList(now);
  const items = net.latest ? net.latest.items || [] : [];

  // La porte est animee sur l'horloge serveur : tout le monde la voit bouger
  // au meme instant, quelle que soit sa latence.
  const doorElapsed = doorAt ? Date.now() + net.clockOffset - doorAt : null;
  updateDoorReach(doorElapsed);

  renderer.centerOn(self.x, self.y);
  renderer.frame(players, items, net.id, now, doorElapsed, doorReachable);
  updateHud(players);
}

/**
 * Portee du mecanisme : meme distance que celle revalidee par le serveur.
 * L'invite disparait des que la sequence est lancee — inutile de proposer
 * d'ouvrir une porte qui s'ouvre deja.
 */
function updateDoorReach(doorElapsed) {
  const use = net.config.MAP.door.use;
  const busy = doorElapsed != null && doorElapsed >= 0 && doorElapsed < net.config.MAP.door.duration;
  const near = Math.hypot(self.x - use.x, self.y - use.y) <= use.range;
  const next = near && !busy;
  if (next === doorReachable) return;
  doorReachable = next;
  el('doorBtn').hidden = !next;
}

function sendInputs(dt) {
  inputAcc += dt;
  const axis = input.axis();

  while (inputAcc >= INPUT_STEP) {
    inputAcc -= INPUT_STEP;
    const cmd = { seq: ++seq, dt: INPUT_STEP, ax: axis.x, ay: axis.y };
    applyInput(self, cmd, net.config);   // prediction locale : zero latence ressentie
    pending.push(cmd);
    net.sendInput(cmd);
  }
}

/** Recale la position locale sur celle du serveur puis rejoue les commandes non confirmees. */
function reconcile() {
  const snap = net.latest;
  if (!snap) return;
  const mine = snap.players.find(p => p.id === net.id);
  if (!mine) return;

  pending = pending.filter(cmd => cmd.seq > mine.seq);

  const replayed = { x: mine.x, y: mine.y, angle: mine.a, speed: self.speed };
  for (const cmd of pending) applyInput(replayed, cmd, net.config);

  const gap = Math.hypot(replayed.x - self.x, replayed.y - self.y);
  if (gap > 90) {
    self.x = replayed.x; self.y = replayed.y;
  } else {
    self.x += (replayed.x - self.x) * 0.25;
    self.y += (replayed.y - self.y) * 0.25;
  }
  self.angle = replayed.angle;
}

/** Joueurs distants interpoles dans le passe, joueur local pris depuis la prediction. */
function buildPlayerList(now) {
  const renderTime = Date.now() + net.clockOffset - net.config.NET.interpDelayMs;
  const frames = net.framesAt(renderTime);
  if (!frames) return [];

  const out = [];
  for (const b of frames.b.players) {
    const isSelf = b.id === net.id;
    const a = frames.a.players.find(p => p.id === b.id) || b;

    const player = {
      id: b.id,
      name: b.n,
      color: b.c,
      tint: b.c2 || b.c,
      classId: b.k,
      x: isSelf ? self.x : a.x + (b.x - a.x) * frames.t,
      y: isSelf ? self.y : a.y + (b.y - a.y) * frames.t,
      angle: isSelf ? self.angle : b.a,
      dropProgress: 1,
      bubble: chat.bubbleFor(b.id)
    };

    if (b.st === 1) {
      if (!dropStarts.has(b.id)) dropStarts.set(b.id, now);
      const elapsed = now - dropStarts.get(b.id);
      player.dropProgress = Math.min(1, elapsed / net.config.SPAWN.dropMs);
    } else {
      dropStarts.delete(b.id);
    }
    out.push(player);
  }
  return out;
}

function isDropping(id) {
  const snap = net.latest;
  const mine = snap && snap.players.find(p => p.id === id);
  return !!(mine && mine.st === 1);
}

let rosterSignature = ''; // evite de reconstruire (et de casser les clics sur) le roster a chaque frame

function updateHud(players) {
  el('playerCount').textContent = players.length;
  el('ping').textContent = net.ping;

  // Le roster ne change que quand quelqu'un rejoint/part/change de classe :
  // le reconstruire a 60 fps detruirait les boutons sous le clic de l'utilisateur.
  const signature = players.map(p => `${p.id}:${p.name}:${p.classId}`).join('|');
  if (signature === rosterSignature) return;
  rosterSignature = signature;
  chat.roster = players.filter(p => p.id !== net.id).map(p => ({ id: p.id, name: p.name }));

  const roster = el('roster');
  roster.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const label = document.createElement('span');
    label.className = 'roster-name';
    const cls = catalog && catalog.classes[p.classId] ? catalog.classes[p.classId].name : '';
    label.textContent = p.id === net.id ? `${p.name} (toi) — ${cls}` : `${p.name} — ${cls}`;
    li.append(dot, label);

    if (p.id === net.id) {
      label.classList.add('me');
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'trade-btn';
      btn.textContent = 'Échanger';
      btn.addEventListener('click', () => net.tradeRequest(p.id));
      li.appendChild(btn);
    }
    roster.appendChild(li);
  }
}

// --- Branchements UI ---------------------------------------------------
el('tabLogin').addEventListener('click', () => setMode('login'));
el('tabRegister').addEventListener('click', () => setMode('register'));
el('submitBtn').addEventListener('click', submit);
el('logoutBtn').addEventListener('click', () => { Auth.logout(); location.reload(); });
el('switchAccountBtn').addEventListener('click', () => { Auth.logout(); location.reload(); });
for (const id of ['username', 'password']) {
  el(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}
// Derniere sauvegarde avant fermeture de l'onglet.
// F2 : affiche la grille de collision de la salle, pratique pour caler un
// obstacle apres avoir touche a server/map.js.
// E : actionne la grande porte quand on est devant. Ignore pendant qu'on tape.
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'e' || !joined || chat.isTyping()) return;
  e.preventDefault();
  net.useDoor();
});

el('doorBtn').addEventListener('click', () => net.useDoor());

window.addEventListener('keydown', (e) => {
  if (e.key !== 'F2' || !renderer || chat.isTyping()) return;
  e.preventDefault();
  renderer.debug = !renderer.debug;
  log(renderer.debug ? 'Collisions affichées (F2).' : 'Collisions masquées.');
});

window.addEventListener('beforeunload', () => net.requestSave());

// --- Echanges entre comptes ---
el('tradeAcceptBtn').addEventListener('click', () => {
  if (!incomingTrade) return;
  net.tradeRespond(true);
  el('tradeIncoming').hidden = true;
});
el('tradeDeclineBtn').addEventListener('click', () => {
  if (!incomingTrade) return;
  net.tradeRespond(false);
  incomingTrade = null;
  el('tradeIncoming').hidden = true;
});
el('tradeCloseBtn').addEventListener('click', () => {
  net.tradeCancel();
  activeTrade = null;
  el('tradeModal').hidden = true;
});
el('tradeConfirmBtn').addEventListener('click', () => net.tradeConfirm());

el('username').focus();
boot();
