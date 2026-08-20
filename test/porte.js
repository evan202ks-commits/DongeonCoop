/**
 * Tests de fumee de la grande porte : elle ne s'ouvre qu'au depot d'un joueur,
 * tous les clients de la salle recoivent le meme horodatage, et une arrivee
 * pendant l'attente prolonge l'ouverture au lieu de rejouer la sequence.
 * Lancer le serveur puis :  node test/porte.js
 */
const { io } = require('socket.io-client');
const CONFIG = require('../server/config');
const DungeonMap = require('../server/map');

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const DOOR = DungeonMap.DOOR;
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
    const client = { socket, doors: [], welcome: null, chat: [] };
    socket.on('welcome', (d) => { client.welcome = d; resolve(client); });
    socket.on('door:open', (d) => client.doors.push(d));
    socket.on('chat:message', (m) => client.chat.push(m));
    socket.on('connect', () => socket.emit('join', { token, classId }));
  });
}

(async () => {
  const stamp = Date.now().toString(36).slice(-5);

  // --- Geometrie livree au client ---------------------------------------
  const a = await play(await register(`porteA${stamp}`), 'mage');
  await wait(150);
  const door = a.welcome.config.MAP.door;
  check('geometrie de la porte envoyee dans la config',
    !!door && !!door.arch && !!door.wheel && !!door.timing,
    door ? `arche r=${door.arch.r} rouage r=${door.wheel.r}` : 'absente');
  check('duree totale coherente avec les etapes',
    door.duration === door.timing.unlock + door.timing.rotate + door.timing.slide
                    + door.timing.hold + door.timing.close,
    `${door.duration} ms`);
  check('instant d\'ouverture avant la duree totale',
    door.openedAt > 0 && door.openedAt < door.duration, `${door.openedAt} ms`);
  check('battants assez longs pour degager l\'arche', door.slide >= door.arch.r);

  // --- Declenchement au depot -------------------------------------------
  check('la porte s\'ouvre pour l\'arrivant', a.doors.length === 1, `${a.doors.length} evenement(s)`);
  check('etat de la porte joint au welcome',
    !!a.welcome.door && a.welcome.door.at === a.doors[0].at);
  check('l\'arrivant est nomme', !!a.doors[0].by, a.doors[0].by);
  check('ouverture annoncee dans le canal Info',
    a.chat.some(m => m.ch === 'info' && m.text.includes('porte')));

  // --- Aucun autre evenement ne l'ouvre ----------------------------------
  a.doors.length = 0;
  a.socket.emit('chat:send', { channel: 'general', text: 'je parle' });
  a.socket.emit('input', { seq: 1, dt: 0.03, ax: 1, ay: 0 });
  a.socket.emit('inventory:drop', 0);
  await wait(400);
  check('ni la parole ni le deplacement n\'ouvrent la porte', a.doors.length === 0);

  // --- Sequence en cours : on ne la rejoue pas ---------------------------
  const first = a.welcome.door.at;
  const b = await play(await register(`porteB${stamp}`), 'archer');
  await wait(150);
  check('deuxieme arrivee pendant la sequence : meme horodatage',
    b.welcome.door.at === first && a.doors[0] && a.doors[0].at === first,
    `${b.welcome.door.at} vs ${first}`);
  check('les deux clients animent sur le meme instant',
    b.doors[0] && b.doors[0].at === a.doors[0].at);

  // --- Porte deja ecartee : l'attente est prolongee ----------------------
  await wait(DOOR.openedAt + 200 - (Date.now() - first));
  a.doors.length = 0;
  const c = await play(await register(`porteC${stamp}`), 'voleur');
  await wait(150);
  const extended = c.welcome.door.at;
  check('arrivee porte ouverte : la fermeture est repoussee',
    extended > first, `${extended - first} ms plus tard`);
  check('la porte repart de l\'instant d\'ouverture, pas du debut',
    Math.abs((Date.now() - extended) - DOOR.openedAt) < 400,
    `${Math.round(Date.now() - extended)} ms dans la sequence`);

  // --- Une fois refermee, la sequence complete est rejouee ---------------
  await wait(DOOR.duration - DOOR.openedAt + 300);
  const d = await play(await register(`porteD${stamp}`), 'barbare');
  await wait(150);
  check('porte au repos : sequence complete rejouee',
    Math.abs(Date.now() - d.welcome.door.at) < 400,
    `${Math.round(Date.now() - d.welcome.door.at)} ms dans la sequence`);

  for (const client of [a, b, c, d]) client.socket.close();
  await wait(200);
  console.log(failures ? `\n${failures} test(s) en echec.` : '\nTout est vert.');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
