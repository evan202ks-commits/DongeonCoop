/**
 * Tests de fumee : multijoueur, comptes, persistance.
 * Lancer le serveur puis :  node test/smoke.js
 * Port personnalise :       PORT=3100 node test/smoke.js
 */
const { io } = require('socket.io-client');
const CONFIG = require('../server/config');

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function api(route, body) {
  const res = await fetch(`${URL}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** Connecte un joueur avec son jeton et expose son etat temps reel. */
function play(token) {
  return new Promise((resolve) => {
    const socket = io(URL);
    const client = { socket, seq: 0, last: null, inventory: [], items: [], welcome: null, error: null };
    socket.on('welcome', (d) => {
      client.welcome = d;
      client.inventory = d.inventory;
      client.spawn = { x: d.you.x, y: d.you.y };
      resolve(client);
    });
    socket.on('auth:error', (msg) => { client.error = msg; resolve(client); });
    socket.on('state', (snap) => {
      const me = snap.players.find(p => p.id === socket.id);
      if (me) { client.last = me; client.seen = snap.players.length; }
      client.items = snap.items;
    });
    socket.on('inventory', (d) => { client.inventory = d.slots; client.stats = d.stats; });
    socket.on('connect', () => socket.emit('join', { token }));
  });
}

function push(client, ax, ay, ms) {
  const timer = setInterval(() => {
    client.socket.emit('input', { seq: ++client.seq, dt: 1 / 30, ax, ay });
  }, 33);
  return wait(ms).then(() => { clearInterval(timer); return wait(200); });
}

const filled = (inv) => inv.filter(Boolean).length;

/** Marche vers l'objet au sol le plus proche jusqu'a atteindre `wanted` cases remplies. */
async function walkToLoot(client, wanted = 1, tries = 80) {
  for (let i = 0; i < tries && filled(client.inventory) < wanted; i++) {
    const target = (client.items || [])
      .map(it => ({ it, d: Math.hypot(it.x - client.last.x, it.y - client.last.y) }))
      .sort((p, q) => p.d - q.d)[0];
    if (!target) { await wait(200); continue; }
    const dx = target.it.x - client.last.x, dy = target.it.y - client.last.y;
    const len = Math.hypot(dx, dy) || 1;
    await push(client, dx / len, dy / len, 200);
  }
  return filled(client.inventory);
}

(async () => {
  const suffix = Date.now().toString(36).slice(-5);
  const user = `Test${suffix}`;

  // --- Comptes ---
  const short = await api('/api/register', { username: 'ab', password: 'motdepasse' });
  check('pseudo trop court refuse', short.status === 400, short.data.error);

  const weak = await api('/api/register', { username: user, password: '123' });
  check('mot de passe trop court refuse', weak.status === 400, weak.data.error);

  const created = await api('/api/register', { username: user, password: 'motdepasse' });
  check('creation de compte', created.status === 200 && !!created.data.token);

  const dupe = await api('/api/register', { username: user.toUpperCase(), password: 'motdepasse' });
  check('pseudo deja pris refuse (insensible a la casse)', dupe.status === 400, dupe.data.error);

  const wrong = await api('/api/login', { username: user, password: 'mauvais' });
  check('mauvais mot de passe refuse', wrong.status === 401);

  const logged = await api('/api/login', { username: user, password: 'motdepasse' });
  check('connexion valide', logged.status === 200 && !!logged.data.token);

  const me = await fetch(`${URL}/api/me`, { headers: { Authorization: `Bearer ${logged.data.token}` } });
  check('reprise de session par jeton', me.status === 200);

  const forged = await fetch(`${URL}/api/me`, { headers: { Authorization: 'Bearer faux.123.signature' } });
  check('jeton falsifie rejete', forged.status === 401);

  const anon = await play('n-importe-quoi');
  check('entree en jeu sans jeton valide refusee', !!anon.error, anon.error);
  anon.socket.close();

  // --- Premier depot ---
  const token = logged.data.token;
  const a = await play(token);
  const cx = CONFIG.WORLD.width / 2, cy = CONFIG.WORLD.height / 2;
  check('nouveau compte depose sur l anneau',
    Math.abs(Math.hypot(a.spawn.x - cx, a.spawn.y - cy) - CONFIG.SPAWN.ringRadius) < 1);
  check('inventaire vide au depart', filled(a.inventory) === 0);

  await push(a, 1, 0, 300);
  check('immobile pendant la chute', Math.hypot(a.last.x - a.spawn.x, a.last.y - a.spawn.y) < 1);

  await wait(CONFIG.SPAWN.dropMs);
  const from = { x: a.last.x, y: a.last.y };
  await push(a, 1, 0, 1000);
  const dist = Math.hypot(a.last.x - from.x, a.last.y - from.y);
  check('deplacement autoritatif apres depot', dist > CONFIG.PLAYER.speed * 0.7, `${dist.toFixed(0)}px`);

  // --- Ramassage / rejet ---
  await walkToLoot(a, 1);
  check('objet ramasse en marchant dessus', filled(a.inventory) > 0,
    a.inventory.filter(Boolean).map(s => `${s.type}x${s.qty}`).join(', ') || 'rien');

  const slot = a.inventory.findIndex(Boolean);
  if (slot >= 0) {
    const beforeDrop = a.inventory[slot].qty;
    a.socket.emit('inventory:drop', slot);
    await wait(300);
    const after = a.inventory[slot] ? a.inventory[slot].qty : 0;
    check('objet jete depuis l inventaire', after === beforeDrop - 1, `${beforeDrop} -> ${after}`);
    await wait(CONFIG.INVENTORY.dropCooldownMs + 200);
  }

  // On repart chercher du butin : la persistance doit etre testee sur un inventaire rempli.
  const carried = await walkToLoot(a, 2);
  check('inventaire rempli avant deconnexion', carried >= 1, `${carried} case(s)`);

  // --- Persistance ---
  const savedPos = { x: a.last.x, y: a.last.y };
  const savedInv = JSON.stringify(a.inventory);
  a.socket.close();
  await wait(700);

  const b = await play(token);
  const gap = Math.hypot(b.spawn.x - savedPos.x, b.spawn.y - savedPos.y);
  check('position rechargee a la reconnexion', gap < 5, `écart ${gap.toFixed(1)}px`);
  check('inventaire recharge a la reconnexion',
    filled(b.inventory) > 0 && JSON.stringify(b.inventory) === savedInv,
    `${filled(b.inventory)} case(s) : ` + (b.inventory.filter(Boolean).map(s => `${s.type}x${s.qty}`).join(', ') || 'vide'));
  check('reprise signalee au client', b.welcome.you.restored === true);
  check('statistiques conservees', (b.welcome.you.stats.sessions || 0) >= 2,
    `${b.welcome.you.stats.sessions} sessions, ${b.welcome.you.stats.pickups} ramassages`);

  // --- Double connexion du meme compte ---
  const c = await play(token);
  await wait(500);
  check('seconde session ejecte la premiere', b.socket.disconnected || !!b.error);
  c.socket.close();
  await wait(300);

  // --- Triche sur dt ---
  const other = await api('/api/register', { username: `Autre${suffix}`, password: 'motdepasse' });
  const d = await play(other.data.token);
  await wait(CONFIG.SPAWN.dropMs + 200);
  await push(d, 1, 0, 300);
  const before = { x: d.last.x, y: d.last.y };
  for (let i = 0; i < 200; i++) d.socket.emit('input', { seq: ++d.seq, dt: 5, ax: 1, ay: 0 });
  await wait(500);
  const cheat = Math.hypot(d.last.x - before.x, d.last.y - before.y);
  const legitMax = CONFIG.PLAYER.speed * 1.5;
  check('triche sur dt bornee', cheat < legitMax, `${cheat.toFixed(0)}px (plafond ${legitMax}px, sans garde-fou 260000px)`);
  d.socket.close();

  console.log(failures ? `\n${failures} echec(s)` : '\nTout est vert.');
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
})();
