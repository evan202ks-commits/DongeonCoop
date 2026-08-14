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

const self = { x: 0, y: 0, angle: 0, name: '', color: '#4ade80' };
const dropStarts = new Map();   // id -> debut de chute (pour l'animation)
let joined = false;
let lastFrame = performance.now();

const el = (id) => document.getElementById(id);

// --- Simulation locale : doit rester identique a Room.applyInput cote serveur ---
function applyInput(entity, cmd, config) {
  let { ax, ay } = cmd;
  const len = Math.hypot(ax, ay);
  if (len > 1) { ax /= len; ay /= len; }

  entity.x += ax * config.PLAYER.speed * cmd.dt;
  entity.y += ay * config.PLAYER.speed * cmd.dt;
  if (len > 0.01) entity.angle = Math.atan2(ay, ax);

  const r = config.PLAYER.radius;
  entity.x = Math.max(r, Math.min(config.WORLD.width - r, entity.x));
  entity.y = Math.max(r, Math.min(config.WORLD.height - r, entity.y));
}

// --- Entree dans la partie ---
function join() {
  const name = el('nameInput').value.trim();
  el('joinBtn').disabled = true;
  el('joinBtn').textContent = 'Connexion…';
  net.connect(name);
}

net.onWelcome = (data) => {
  self.x = data.you.x;
  self.y = data.you.y;
  self.angle = data.you.angle;
  self.name = data.you.name;
  self.color = data.you.color;
  dropStarts.set(data.id, performance.now());

  renderer = new Renderer(el('stage'), data.config);
  renderer.centerOn(self.x, self.y);

  el('roomId').textContent = data.roomId;
  el('gate').classList.add('hidden');
  joined = true;
  log(`Tu es déposé sur le terrain, ${self.name}.`);
  requestAnimationFrame(loop);
};

net.onEvent = (type, payload) => {
  if (type === 'join') log(`${payload.name} arrive sur le terrain.`);
  if (type === 'leave') log(`${payload.name} a quitté le terrain.`);
  if (type === 'disconnect') log('Connexion perdue — reconnexion…');
};

function log(message) {
  const box = el('log');
  const line = document.createElement('div');
  line.textContent = message;
  box.appendChild(line);
  while (box.children.length > 4) box.removeChild(box.firstChild);
}

// --- Boucle de rendu ---
function loop(now) {
  requestAnimationFrame(loop);
  if (!joined || !net.config) return;

  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  const dropping = isDropping(net.id, now);
  if (!dropping) sendInputs(dt);
  reconcile();

  const players = buildPlayerList(now);
  renderer.centerOn(self.x, self.y);
  renderer.frame(players, net.id, now);
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

  const replayed = { x: mine.x, y: mine.y, angle: mine.a };
  for (const cmd of pending) applyInput(replayed, cmd, net.config);

  // Correction douce si l'ecart est faible, saut sec s'il est gros (teleport, respawn).
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

function isDropping(id, now) {
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
    label.textContent = p.id === net.id ? `${p.name} (toi)` : p.name;
    if (p.id === net.id) label.className = 'me';
    li.append(dot, label);
    roster.appendChild(li);
  }
}

el('joinBtn').addEventListener('click', join);
el('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
el('nameInput').focus();
