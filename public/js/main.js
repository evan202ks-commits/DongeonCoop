import { Auth } from './auth.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Renderer } from './render.js';

const net = new Net();
const input = new Input();
let renderer = null;

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
let mode = 'login';
let lastFrame = performance.now();

const el = (id) => document.getElementById(id);

// --- Simulation locale : doit rester identique a Room.applyInput cote serveur ---
function applyInput(entity, cmd, config) {
  let { ax, ay } = cmd;
  const len = Math.hypot(ax, ay);
  if (len > 1) { ax /= len; ay /= len; }

  // La vitesse depend de la classe et des artefacts equipes, pas de CONFIG.
  const speed = entity.speed || config.PLAYER.speed;
  entity.x += ax * speed * cmd.dt;
  entity.y += ay * speed * cmd.dt;
  if (len > 0.01) entity.angle = Math.atan2(ay, ax);

  const r = config.PLAYER.radius;
  entity.x = Math.max(r, Math.min(config.WORLD.width - r, entity.x));
  entity.y = Math.max(r, Math.min(config.WORLD.height - r, entity.y));
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

  renderer = new Renderer(el('stage'), data.config, data.items, data.classes);
  renderer.centerOn(self.x, self.y);

  el('roomId').textContent = data.roomId;
  el('pickups').textContent = data.you.stats?.pickups || 0;
  el('classLabel').textContent = catalog.classes[data.you.classId].name;
  el('gate').classList.add('hidden');
  el('classGate').hidden = true;
  drawInventory();
  drawEquipment();
  drawAttrs(data.you.attrs);

  joined = true;
  log(data.you.restored
    ? `${catalog.classes[data.you.classId].name} repris là où tu t'étais arrêté.`
    : `${self.name} entre sur le terrain en ${catalog.classes[data.you.classId].name}.`);
  requestAnimationFrame(loop);
};

net.onInventory = (data) => {
  inventory = data.slots;
  if (data.equipment) equipment = data.equipment;
  if (data.attrs) { self.speed = data.attrs.speed; drawAttrs(data.attrs); }
  drawInventory();
  drawEquipment();
  if (data.picked) log(`+${data.picked.qty} ${data.picked.name}`);
  if (data.equipped) log(`${data.equipped} équipé.`);
  if (data.stats) el('pickups').textContent = data.stats.pickups || 0;
};

net.onEvent = (type, payload) => {
  if (type === 'join') log(`${payload.name} arrive sur le terrain.`);
  if (type === 'leave') log(`${payload.name} a quitté le terrain.`);
  if (type === 'notice') log(payload.msg);
  if (type === 'disconnect') log('Connexion perdue — reconnexion…');
  if (type === 'auth-error') {
    joined = false;
    el('classGate').hidden = true;
    el('gate').classList.remove('hidden');
    el('submitBtn').disabled = false;
    el('submitBtn').textContent = mode === 'login' ? 'Se connecter' : 'Créer le compte';
    el('authError').textContent = payload.msg;
  }
};

function log(message) {
  const box = el('log');
  const line = document.createElement('div');
  line.textContent = message;
  box.appendChild(line);
  while (box.children.length > 4) box.removeChild(box.firstChild);
}

// --- Inventaire et equipement ------------------------------------------
const itemDef = (type) => net.items[type] || { color: '#94a3b8', name: type };

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
      gem.style.background = def.color;
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
      gem.style.background = def.color;
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

  renderer.centerOn(self.x, self.y);
  renderer.frame(players, items, net.id, now);
  updateHud(players);
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
      dropProgress: 1
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

function updateHud(players) {
  el('playerCount').textContent = players.length;
  el('ping').textContent = net.ping;

  const roster = el('roster');
  roster.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const label = document.createElement('span');
    const cls = catalog && catalog.classes[p.classId] ? catalog.classes[p.classId].name : '';
    label.textContent = p.id === net.id ? `${p.name} (toi) — ${cls}` : `${p.name} — ${cls}`;
    if (p.id === net.id) label.className = 'me';
    li.append(dot, label);
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
window.addEventListener('beforeunload', () => net.requestSave());

el('username').focus();
boot();
