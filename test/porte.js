/**
 * Tests de fumee de la grande porte : elle ne s'ouvre QUE sur un appui E
 * lance depuis la zone d'action, jamais toute seule, et tous les clients de
 * la salle animent sur le meme horodatage.
 * Lancer le serveur puis :  node test/porte.js
 */
const { io } = require('socket.io-client');
const CONFIG = require('../server/config');
const DungeonMap = require('../server/map');

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const DOOR = DungeonMap.DOOR;
const dist = (p) => Math.hypot(p.x - DOOR.use.x, p.y - DOOR.use.y);
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function register(username) {
  const res = await fetch(`${URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'motdepasse' })
  });
  const data = await res.json();
  if (data.error) throw new Error(`${username} : ${data.error}`);
  return data.token;
}

function play(token, classId) {
  return new Promise((resolve) => {
    const socket = io(URL);
    const client = { socket, doors: [], chat: [], welcome: null, seq: 0 };
    socket.on('welcome', (d) => {
      client.welcome = d;
      client.pos = { x: d.you.x, y: d.you.y };
      resolve(client);
    });
    socket.on('door:open', (d) => client.doors.push(d));
    socket.on('chat:message', (m) => client.chat.push(m));
    socket.on('connect', () => socket.emit('join', { token, classId }));
  });
}

/** Pousse le personnage vers la porte : le serveur ne croit que sa propre position. */
async function walkToDoor(client) {
  for (let i = 0; i < 200; i++) {
    const dx = DOOR.use.x - client.pos.x;
    const dy = DOOR.use.y - client.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    if (len < 40) break;
    client.socket.emit('input', { seq: ++client.seq, dt: 0.05, ax: dx / len, ay: dy / len });
    client.pos.x += (dx / len) * 250 * 0.05;
    client.pos.y += (dy / len) * 250 * 0.05;
    if (i % 8 === 0) await wait(20);
  }
  await wait(250);
}

const saidTo = (c, needle) => c.chat.some(m => m.text.includes(needle));

(async () => {
  const stamp = Date.now().toString(36).slice(-5);

  // --- Geometrie livree au client ---------------------------------------
  const far = await play(await register(`porteA${stamp}`), 'mage');
  await wait(200);
  const door = far.welcome.config.MAP.door;
  check('geometrie de la porte envoyee dans la config',
    !!door && !!door.arch && !!door.wheel && !!door.use,
    door ? `arche r=${door.arch.r} · portee ${door.use.range}` : 'absente');
  check('duree totale coherente avec les etapes',
    door.duration === door.timing.unlock + door.timing.rotate + door.timing.slide
                    + door.timing.hold + door.timing.close, `${door.duration} ms`);
  check('zone d\'action posee sur la dalle, atteignable',
    !DungeonMap.blocked(door.use.x, door.use.y, CONFIG.PLAYER.radius));
  check('la course degage entierement l\'arche', door.slide >= door.arch.r,
    `course ${door.slide} px pour un rayon de ${door.arch.r}`);
  check('le rouage tient dans le battant',
    door.wheel.y - door.wheel.r >= door.arch.y - door.arch.r
    && Math.abs(door.wheel.x - door.arch.x) + door.wheel.r <= door.arch.r
    && door.wheel.y + door.wheel.r - door.arch.bottom <= 6,
    `debord bas ${door.wheel.y + door.wheel.r - door.arch.bottom} px`);

  // --- Le depot n'ouvre plus rien ---------------------------------------
  await wait(CONFIG.SPAWN.dropMs + 300);
  check('la porte ne s\'ouvre pas au depot du joueur', far.doors.length === 0,
    `${far.doors.length} evenement(s)`);
  check('porte au repos dans le welcome', far.welcome.door.at === 0);

  // --- Hors de portee : refus -------------------------------------------
  // On eloigne le personnage de la porte avant d'essayer.
  for (let i = 0; i < 60; i++) {
    far.socket.emit('input', { seq: ++far.seq, dt: 0.05, ax: 0, ay: 1 });
    if (i % 8 === 0) await wait(20);
  }
  await wait(300);
  far.chat.length = 0;
  far.socket.emit('door:use');
  await wait(250);
  check('appui hors de portee refuse', far.doors.length === 0);
  check('le refus est explique au joueur', saidTo(far, 'Approche-toi'),
    (far.chat.find(m => m.ch === 'info' || m.ch === 'erreur') || {}).text);

  // --- Devant la porte : ouverture --------------------------------------
  const near = await play(await register(`porteB${stamp}`), 'archer');
  await wait(CONFIG.SPAWN.dropMs + 300);
  await walkToDoor(near);
  far.doors.length = 0;
  near.doors.length = 0;

  near.socket.emit('door:use');
  await wait(300);
  check('appui devant la porte : elle s\'ouvre', near.doors.length === 1,
    `${near.doors.length} evenement(s)`);
  check('les autres joueurs de la salle sont prevenus', far.doors.length === 1);
  check('tout le monde anime sur le meme instant',
    near.doors[0] && far.doors[0] && near.doors[0].at === far.doors[0].at);
  check('l\'auteur est nomme', !!near.doors[0].by, near.doors[0].by);
  check('ouverture annoncee dans le canal Info',
    near.chat.some(m => m.ch === 'info' && m.text.includes('mécanisme')));

  const first = near.doors[0].at;

  // --- Sequence en cours : pas de rejeu ---------------------------------
  near.doors.length = 0;
  await wait(600);
  near.socket.emit('door:use');
  await wait(250);
  check('appui pendant la sequence : ignore', near.doors.length === 0);

  // --- Porte ouverte : la fermeture est repoussee -----------------------
  await wait(Math.max(0, DOOR.openedAt + 250 - (Date.now() - first)));
  near.doors.length = 0;
  near.socket.emit('door:use');
  await wait(250);
  check('appui porte ouverte : la fermeture est repoussee',
    near.doors.length === 1 && near.doors[0].at > first,
    near.doors[0] ? `${near.doors[0].at - first} ms plus tard` : 'aucun evenement');

  // --- Un arrivant reprend la sequence en cours -------------------------
  const late = await play(await register(`porteC${stamp}`), 'voleur');
  await wait(200);
  check('l\'arrivant recoit la sequence en cours',
    late.welcome.door.at === near.doors[0].at,
    `${late.welcome.door.at} vs ${near.doors[0].at}`);

  // --- Rien d'autre ne l'ouvre ------------------------------------------
  await wait(DOOR.duration + 300);
  near.doors.length = 0;
  near.socket.emit('chat:send', { channel: 'general', text: 'ouvre-toi' });
  near.socket.emit('inventory:drop', 0);
  near.socket.emit('input', { seq: ++near.seq, dt: 0.03, ax: 0, ay: -1 });
  await wait(400);
  check('ni la parole ni le deplacement n\'ouvrent la porte', near.doors.length === 0);

  for (const client of [far, near, late]) client.socket.close();
  await wait(200);
  console.log(failures ? `\n${failures} test(s) en echec.` : '\nTout est vert.');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
