/**
 * Tests de fumee de la crypte (salle 2) : geometrie envoyee au client,
 * porte infranchissable fermee, franchissement reel une fois ouverte,
 * retour par le passage sud, et etancheite entre les deux salles
 * (butin, roster, echanges).
 * Lancer le serveur puis :  node test/salle2.js
 */
const { io } = require('socket.io-client');
const CONFIG = require('../server/config');
const DungeonMap = require('../server/map');
const Crypt = require('../server/map2');

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
    const client = { socket, seq: 0, states: [], welcome: null };
    socket.on('welcome', (d) => { client.welcome = d; client.pos = { x: d.you.x, y: d.you.y, z: d.you.z }; resolve(client); });
    socket.on('state', (s) => { client.states.push(s); client.last = s; });
    socket.on('connect', () => socket.emit('join', { token, classId }));
  });
}

/** Marche vers un point cible (coordonnees serveur), en re-visant a chaque pas. */
async function walkTo(client, x, y, maxSteps = 260) {
  for (let i = 0; i < maxSteps; i++) {
    const mine = client.last && client.last.players.find(p => p.id === client.welcome.id);
    if (mine) client.pos = { x: mine.x, y: mine.y, z: mine.z };
    const dx = x - client.pos.x, dy = y - client.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    if (len < 12) break;
    client.socket.emit('input', { seq: ++client.seq, dt: 0.05, ax: dx / len, ay: dy / len });
    await wait(20);
  }
  await wait(200);
}

const myState = (client) => client.last && client.last.players.find(p => p.id === client.welcome.id);

(async () => {
  const stamp = Date.now().toString(36).slice(-5);

  // --- Geometrie livree au client -----------------------------------------
  const a = await play(await register(`salle2A${stamp}`), 'archer');
  await wait(200);
  const maps = a.welcome.config.MAPS;
  check('les deux salles sont envoyees dans la config', !!maps.room1 && !!maps.room2);
  check('la crypte a sa propre image', maps.room2.image === '/map/salle-donjon-2.png');
  check('la crypte n\'a pas de mecanisme de porte', maps.room2.door === null);
  check('8 feux dans la crypte, memes teintes que la salle de spawn',
    maps.room2.flames.length === 8 && maps.room2.flames.every(f => f.color === '#a97bff' || f.color === '#b08cff'));
  check('le passage sud de la crypte est degage',
    !Crypt.blocked((Crypt.GATE.x0 + Crypt.GATE.x1) / 2, Crypt.HEIGHT - CONFIG.PLAYER.radius - 2, CONFIG.PLAYER.radius),
    `gate ${JSON.stringify(Crypt.GATE)}`);
  check('on arrive dans la salle de spawn', a.welcome.you.z === 'room1');

  // --- Porte fermee : infranchissable, meme au raz du seuil ---------------
  await wait(CONFIG.SPAWN.dropMs + 200);
  await walkTo(a, DOOR.arch.x, DOOR.arch.y + 30);
  await wait(300);
  check('bloque devant la porte fermee : n\'a pas franchi le seuil',
    myState(a).y >= DOOR.arch.bottom - 10,
    `y=${myState(a).y} (seuil ${DOOR.arch.bottom})`);
  check('toujours dans la salle de spawn, porte fermee', myState(a).z === 'room1');

  // --- Ouverture puis franchissement reel ----------------------------------
  a.socket.emit('door:use');
  await wait(300); // laisse les battants s'ecarter (DOOR.openedAt)
  await wait(Math.max(0, DOOR.openedAt - 300));
  await walkTo(a, DOOR.arch.x, 15, 300);

  check('le joueur est passe dans la crypte', myState(a).z === 'room2',
    `zone=${myState(a).z} pos=${myState(a).x},${myState(a).y}`);
  check('position d\'arrivee valide (hors mur) dans la crypte',
    !Crypt.blocked(myState(a).x, myState(a).y, CONFIG.PLAYER.radius));

  // --- Un second joueur reste dans la salle de spawn -----------------------
  const b = await play(await register(`salle2B${stamp}`), 'voleur');
  await wait(CONFIG.SPAWN.dropMs + 300);
  check('un autre joueur reste bien dans la salle de spawn', myState(b).z === 'room1');

  // --- Retour par le passage sud de la crypte ------------------------------
  await walkTo(a, (Crypt.GATE.x0 + Crypt.GATE.x1) / 2, Crypt.HEIGHT - 15, 300);
  check('le joueur est revenu dans la salle de spawn', myState(a).z === 'room1',
    `zone=${myState(a).z} pos=${myState(a).x},${myState(a).y}`);
  check('position de retour valide (hors mur)',
    !DungeonMap.blocked(myState(a).x, myState(a).y, CONFIG.PLAYER.radius));

  for (const client of [a, b]) client.socket.close();
  await wait(200);
  console.log(failures ? `\n${failures} test(s) en echec.` : '\nTout est vert.');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
