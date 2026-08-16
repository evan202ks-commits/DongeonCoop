/**
 * Tests de fumee : multijoueur, comptes, classes, artefacts, persistance.
 * Lancer le serveur puis :  node test/smoke.js
 * Port personnalise :       PORT=3100 node test/smoke.js
 */
const { io } = require('socket.io-client');
const CONFIG = require('../server/config');
const Classes = require('../server/classes');

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

/** Connecte un joueur avec son jeton et sa classe, expose son etat temps reel. */
function play(token, classId) {
  return new Promise((resolve) => {
    const socket = io(URL);
    const client = { socket, seq: 0, last: null, inventory: [], equipment: {}, items: [], welcome: null, error: null };
    socket.on('welcome', (d) => {
      client.welcome = d;
      client.inventory = d.inventory;
      client.equipment = d.equipment;
      client.attrs = d.you.attrs;
      client.spawn = { x: d.you.x, y: d.you.y };
      resolve(client);
    });
    socket.on('auth:error', (msg) => { client.error = msg; resolve(client); });
    socket.on('state', (snap) => {
      const me = snap.players.find(p => p.id === socket.id);
      if (me) { client.last = me; client.seen = snap.players.length; }
      client.items = snap.items;
    });
    socket.on('inventory', (d) => {
      client.inventory = d.slots;
      if (d.equipment) client.equipment = d.equipment;
      if (d.attrs) client.attrs = d.attrs;
      client.stats = d.stats;
    });
    socket.on('notice', (msg) => { client.notice = msg; });
    socket.on('connect', () => socket.emit('join', { token, classId }));
  });
}

function push(client, ax, ay, ms) {
  const timer = setInterval(() => {
    client.socket.emit('input', { seq: ++client.seq, dt: 1 / 30, ax, ay });
  }, 33);
  return wait(ms).then(() => { clearInterval(timer); return wait(200); });
}

const filled = (inv) => inv.filter(Boolean).length;
const types = (inv) => inv.filter(Boolean).map(s => s.type);
const isArtifact = (t) => Classes.isArtifact(t);
const lootOnly = (inv) => inv.filter(s => s && !isArtifact(s.type));

/** Marche vers l'objet au sol le plus proche jusqu'a ramasser `wanted` piles de butin. */
async function walkToLoot(client, wanted = 1, tries = 80) {
  for (let i = 0; i < tries && lootOnly(client.inventory).length < wanted; i++) {
    const target = (client.items || [])
      .map(it => ({ it, d: Math.hypot(it.x - client.last.x, it.y - client.last.y) }))
      .sort((p, q) => p.d - q.d)[0];
    if (!target) { await wait(200); continue; }
    const dx = target.it.x - client.last.x, dy = target.it.y - client.last.y;
    const len = Math.hypot(dx, dy) || 1;
    await push(client, dx / len, dy / len, 200);
  }
  return lootOnly(client.inventory).length;
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
  check('aucune classe jouee a la creation', created.data.profile.lastClass === null);
  check('les 4 classes sont proposees au nouveau compte',
    Object.keys(created.data.profile.classes).length === 4 &&
    Object.values(created.data.profile.classes).every(c => c.played === false),
    Object.keys(created.data.profile.classes).join(', '));

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

  // --- Catalogue des classes ---
  const cat = await (await fetch(`${URL}/api/classes`)).json();
  check('catalogue des 4 classes servi',
    ['mage', 'barbare', 'archer', 'voleur'].every(id => cat.classes[id]),
    Object.keys(cat.classes).join(', '));
  check('3 artefacts par classe',
    Object.values(cat.classes).every(c => c.artifacts.length === 3));
  check('un artefact par emplacement',
    Object.values(cat.classes).every(c =>
      new Set(c.artifacts.map(a => a.slot)).size === cat.slots.length));

  const anon = await play('n-importe-quoi', 'mage');
  check('entree en jeu sans jeton valide refusee', !!anon.error, anon.error);
  anon.socket.close();

  const token = logged.data.token;
  const noClass = await play(token, undefined);
  check('entree en jeu sans classe refusee', !!noClass.error, noClass.error);
  noClass.socket.close();

  const badClass = await play(token, 'necromancien');
  check('classe inconnue refusee', !!badClass.error, badClass.error);
  badClass.socket.close();
  await wait(200);

  // --- Premiere partie en Mage ---
  const a = await play(token, 'mage');
  const cx = CONFIG.WORLD.width / 2, cy = CONFIG.WORLD.height / 2;
  check('nouveau personnage depose sur l anneau',
    Math.abs(Math.hypot(a.spawn.x - cx, a.spawn.y - cy) - CONFIG.SPAWN.ringRadius) < 1);

  const mageArts = Classes.artifactsOf('mage').map(x => x.id);
  check('les 3 artefacts du Mage sont dans son sac',
    mageArts.every(id => types(a.inventory).includes(id)),
    types(a.inventory).join(', '));
  check('aucun artefact d une autre classe dans le sac',
    types(a.inventory).filter(isArtifact).every(t => Classes.ARTIFACTS[t].classId === 'mage'));
  check('aucun artefact equipe au depart',
    cat.slots.every(s => a.equipment[s] === null));
  check('vitesse de base du Mage appliquee', a.attrs.speed === Classes.CLASSES.mage.base.speed,
    `${a.attrs.speed} px/s`);

  await push(a, 1, 0, 300);
  check('immobile pendant la chute', Math.hypot(a.last.x - a.spawn.x, a.last.y - a.spawn.y) < 1);

  await wait(CONFIG.SPAWN.dropMs);
  const from = { x: a.last.x, y: a.last.y };
  await push(a, 1, 0, 1000);
  const dist = Math.hypot(a.last.x - from.x, a.last.y - from.y);
  check('deplacement a la vitesse de la classe', dist > a.attrs.speed * 0.7, `${dist.toFixed(0)}px`);

  // --- Artefacts : equiper / deseequiper ---
  const orbe = 'orbe_mana';                       // relique du Mage : +10 % de vitesse
  const speedBefore = a.attrs.speed;
  a.socket.emit('equip', orbe);
  await wait(300);
  check('artefact equipe dans son emplacement', a.equipment.relique === orbe, JSON.stringify(a.equipment));
  check('artefact retire de l inventaire une fois equipe', !types(a.inventory).includes(orbe));
  check('les stats montent avec l artefact', a.attrs.speed > speedBefore,
    `${speedBefore} -> ${a.attrs.speed} px/s`);

  const boosted = { x: a.last.x, y: a.last.y };
  await push(a, 0, 1, 1000);
  const boostedDist = Math.hypot(a.last.x - boosted.x, a.last.y - boosted.y);
  check('la vitesse boostee est bien autoritative', boostedDist > speedBefore * 0.95,
    `${boostedDist.toFixed(0)}px pour ${dist.toFixed(0)}px sans artefact`);

  a.socket.emit('unequip', 'relique');
  await wait(300);
  check('artefact deseequipe et rendu au sac',
    a.equipment.relique === null && types(a.inventory).includes(orbe));
  check('les stats redescendent', a.attrs.speed === speedBefore);

  a.socket.emit('equip', 'hache_sanglante');      // artefact du Barbare
  await wait(300);
  check('artefact d une autre classe refuse',
    cat.slots.every(s => a.equipment[s] !== 'hache_sanglante'), a.notice);

  const artSlot = a.inventory.findIndex(s => s && isArtifact(s.type));
  a.socket.emit('inventory:drop', artSlot);
  await wait(300);
  check('artefact impossible a jeter', a.inventory[artSlot] && isArtifact(a.inventory[artSlot].type));

  // --- Ramassage / rejet ---
  await walkToLoot(a, 1);
  check('objet ramasse en marchant dessus', lootOnly(a.inventory).length > 0,
    lootOnly(a.inventory).map(s => `${s.type}x${s.qty}`).join(', ') || 'rien');

  const slot = a.inventory.findIndex(s => s && !isArtifact(s.type));
  if (slot >= 0) {
    const beforeDrop = a.inventory[slot].qty;
    a.socket.emit('inventory:drop', slot);
    await wait(300);
    const after = a.inventory[slot] ? a.inventory[slot].qty : 0;
    check('objet jete depuis l inventaire', after === beforeDrop - 1, `${beforeDrop} -> ${after}`);
    await wait(CONFIG.INVENTORY.dropCooldownMs + 200);
  }

  await walkToLoot(a, 2);
  a.socket.emit('equip', 'baton_arkheon');
  await wait(300);

  // --- Persistance par classe ---
  const savedPos = { x: a.last.x, y: a.last.y };
  const savedInv = JSON.stringify(a.inventory);
  const savedEquip = JSON.stringify(a.equipment);
  a.socket.close();
  await wait(700);

  const b = await play(token, 'mage');
  const gap = Math.hypot(b.spawn.x - savedPos.x, b.spawn.y - savedPos.y);
  check('position du Mage rechargee', gap < 5, `écart ${gap.toFixed(1)}px`);
  check('inventaire du Mage recharge', JSON.stringify(b.inventory) === savedInv);
  check('equipement du Mage recharge', JSON.stringify(b.equipment) === savedEquip, savedEquip);
  check('reprise signalee au client', b.welcome.you.restored === true);
  check('statistiques du Mage conservees', (b.welcome.you.stats.sessions || 0) >= 2,
    `${b.welcome.you.stats.sessions} sessions, ${b.welcome.you.stats.pickups} ramassages`);
  b.socket.close();
  await wait(500);

  // --- Une autre classe = un autre personnage ---
  const v = await play(token, 'voleur');
  const voleurArts = Classes.artifactsOf('voleur').map(x => x.id);
  check('le Voleur part avec ses propres artefacts',
    voleurArts.every(id => types(v.inventory).includes(id)),
    types(v.inventory).join(', '));
  check('inventaire du Voleur independant de celui du Mage',
    !types(v.inventory).some(t => mageArts.includes(t)) && lootOnly(v.inventory).length === 0);
  check('equipement du Voleur vierge', cat.slots.every(s => v.equipment[s] === null));
  check('le Voleur depose sur l anneau (personnage neuf)',
    Math.abs(Math.hypot(v.spawn.x - cx, v.spawn.y - cy) - CONFIG.SPAWN.ringRadius) < 1);
  check('vitesse propre au Voleur', v.attrs.speed === Classes.CLASSES.voleur.base.speed,
    `${v.attrs.speed} px/s contre ${Classes.CLASSES.mage.base.speed} au Mage`);
  check('classe diffusee aux autres joueurs', v.welcome.snapshot.players.some(p => p.k === 'voleur'));

  const profileNow = await (await fetch(`${URL}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check('le compte se souvient des classes jouees',
    profileNow.profile.classes.mage.played && profileNow.profile.classes.voleur.played &&
    !profileNow.profile.classes.archer.played);
  check('derniere classe jouee memorisee', profileNow.profile.lastClass === 'voleur');
  v.socket.close();
  await wait(400);

  // --- Double connexion du meme compte ---
  const c1 = await play(token, 'archer');
  const c2 = await play(token, 'barbare');
  await wait(600);
  check('seconde session ejecte la premiere', c1.socket.disconnected || !!c1.error);
  c2.socket.close();
  await wait(300);

  // --- Triche sur dt ---
  const other = await api('/api/register', { username: `Autre${suffix}`, password: 'motdepasse' });
  const d = await play(other.data.token, 'barbare');
  await wait(CONFIG.SPAWN.dropMs + 200);
  await push(d, 1, 0, 300);
  const before = { x: d.last.x, y: d.last.y };
  for (let i = 0; i < 200; i++) d.socket.emit('input', { seq: ++d.seq, dt: 5, ax: 1, ay: 0 });
  await wait(500);
  const cheat = Math.hypot(d.last.x - before.x, d.last.y - before.y);
  const legitMax = d.attrs.speed * 1.5;
  check('triche sur dt bornee', cheat < legitMax, `${cheat.toFixed(0)}px (plafond ${legitMax}px)`);
  d.socket.close();

  console.log(failures ? `\n${failures} echec(s)` : '\nTout est vert.');
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
})();
