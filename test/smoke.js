/**
 * Test de fumee du multijoueur.
 * Lancer le serveur puis :  node test/smoke.js
 * Port personnalise :       PORT=3100 node test/smoke.js
 */
const { io } = require('socket.io-client');
const CONFIG = require('../server/config');

const URL = `http://localhost:${process.env.PORT || 3000}`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function spawnClient(name) {
  return new Promise((resolve) => {
    const socket = io(URL);
    const client = { socket, name, seq: 0, last: null, spawn: null };
    socket.on('welcome', (d) => {
      client.id = d.id;
      client.roomId = d.roomId;
      client.spawn = { x: d.you.x, y: d.you.y };
      resolve(client);
    });
    socket.on('state', (snap) => {
      const me = snap.players.find(p => p.id === socket.id);
      if (me) { client.last = me; client.seen = snap.players.length; }
    });
    socket.on('connect', () => socket.emit('join', { name }));
  });
}

function push(client, ax, ay, ms) {
  const timer = setInterval(() => {
    client.socket.emit('input', { seq: ++client.seq, dt: 1 / 30, ax, ay });
  }, 33);
  return wait(ms).then(() => { clearInterval(timer); return wait(250); });
}

(async () => {
  const [a, b, c] = await Promise.all([spawnClient('Alpha'), spawnClient('Beta'), spawnClient('Gamma')]);

  const cx = CONFIG.WORLD.width / 2, cy = CONFIG.WORLD.height / 2;
  check('depot sur l anneau de spawn',
    [a, b, c].every(p => Math.abs(Math.hypot(p.spawn.x - cx, p.spawn.y - cy) - CONFIG.SPAWN.ringRadius) < 1));
  check('points de depot distincts',
    Math.hypot(a.spawn.x - b.spawn.x, a.spawn.y - b.spawn.y) > 1);
  check('meme salle partagee', a.roomId === b.roomId && b.roomId === c.roomId, a.roomId);

  // Deplacement bloque pendant la chute
  await push(a, 1, 0, 300);
  check('immobile pendant la chute', Math.hypot(a.last.x - a.spawn.x, a.last.y - a.spawn.y) < 1);

  await wait(CONFIG.SPAWN.dropMs);
  const from = { x: a.last.x, y: a.last.y };
  await push(a, 1, 0, 1000);
  const dist = Math.hypot(a.last.x - from.x, a.last.y - from.y);
  check('deplacement autoritatif apres depot', dist > CONFIG.PLAYER.speed * 0.7, `${dist.toFixed(0)}px`);

  check('chaque joueur voit les autres', a.seen === 3, `${a.seen} joueurs`);

  // Triche : dt gonfle
  const before = { x: a.last.x, y: a.last.y };
  for (let i = 0; i < 200; i++) a.socket.emit('input', { seq: ++a.seq, dt: 5, ax: 1, ay: 0 });
  await wait(500);
  const cheat = Math.hypot(a.last.x - before.x, a.last.y - before.y);
  check('triche sur dt bornee', cheat < CONFIG.PLAYER.speed, `${cheat.toFixed(0)}px`);

  [a, b, c].forEach(p => p.socket.close());
  console.log(failures ? `\n${failures} echec(s)` : '\nTout est vert.');
  setTimeout(() => process.exit(failures ? 1 : 0), 250);
})();
