/**
 * Tests de fumee de l'hotel de vente : mise en vente au prix du vendeur,
 * sequestre des objets, achat par un autre joueur, paiement du vendeur meme
 * deconnecte, retrait d'annonce, et tous les refus (prix hors bornes, artefact,
 * bourse insuffisante, sa propre annonce, quota).
 * Lancer le serveur puis :  node test/market.js
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
    const client = {
      socket, classId, welcome: null, inventory: [], gold: 0, seq: 0,
      last: { x: 0, y: 0 }, items: [],
      market: null, errors: [], chat: [], purse: [], changed: 0
    };
    socket.on('welcome', (d) => {
      client.welcome = d;
      client.inventory = d.inventory;
      client.gold = d.gold;
      client.last = { x: d.you.x, y: d.you.y };
      resolve(client);
    });
    socket.on('state', (snap) => {
      const me = snap.players.find(p => p.id === socket.id);
      if (me) client.last = { x: me.x, y: me.y };
      client.items = snap.items || [];
    });
    socket.on('inventory', (d) => { client.inventory = d.slots; });
    socket.on('market:state', (d) => { client.market = d; client.gold = d.gold; });
    socket.on('market:purse', (d) => { client.purse.push(d); client.gold = d.gold; });
    socket.on('market:changed', () => { client.changed++; });
    socket.on('market:error', (m) => client.errors.push(m));
    socket.on('chat:message', (m) => client.chat.push(m));
    socket.on('connect', () => socket.emit('join', { token, classId }));
  });
}

const count = (c, type) => c.inventory.reduce((n, s) => n + (s && s.type === type ? s.qty : 0), 0);

/** Pousse le personnage dans une direction pendant `ms`, comme le ferait le client. */
async function push(client, ax, ay, ms) {
  const steps = Math.max(1, Math.round(ms / 33));
  for (let i = 0; i < steps; i++) {
    client.socket.emit('input', { seq: ++client.seq, dt: 0.033, ax, ay });
    await wait(33);
  }
}

/**
 * Le sac d'un personnage neuf ne contient que ses artefacts, invendables :
 * il faut aller chercher du butin au sol avant de pouvoir tester la vente.
 */
async function walkToLoot(client, wanted = 1, tries = 90) {
  for (let i = 0; i < tries && lootCount(client) < wanted; i++) {
    const target = (client.items || [])
      .map(it => ({ it, d: Math.hypot(it.x - client.last.x, it.y - client.last.y) }))
      .sort((p, q) => p.d - q.d)[0];
    if (!target) { await wait(200); continue; }
    const dx = target.it.x - client.last.x, dy = target.it.y - client.last.y;
    const len = Math.hypot(dx, dy) || 1;
    await push(client, dx / len, dy / len, 200);
  }
  return lootCount(client);
}

const lootCount = (c) => c.inventory.filter(s => s && !Classes.isArtifact(s.type)).length;
const said = (c, needle) => c.chat.some(m => m.text.includes(needle));
const lastError = (c) => c.errors[c.errors.length - 1];

/** Trouve un type de butin empilable present dans le sac, sinon en fait tomber. */
function sellableType(client) {
  for (const slot of client.inventory) {
    if (!slot) continue;
    if (Classes.isArtifact(slot.type)) continue;
    return slot.type;
  }
  return null;
}

(async () => {
  const stamp = Date.now().toString(36).slice(-5);
  const seller = await play(await register(`vend${stamp}`), 'mage');
  const buyer = await play(await register(`achat${stamp}`), 'archer');
  await wait(300);

  // --- Bourse de depart --------------------------------------------------
  check('bourse de depart creditee au compte',
    seller.welcome.gold === CONFIG.MARKET.startingGold, `${seller.welcome.gold} or`);

  seller.socket.emit('market:browse');
  await wait(200);
  check('etat du marche envoye au client',
    !!seller.market && Array.isArray(seller.market.listings),
    seller.market ? `${seller.market.listings.length} annonce(s) · ${seller.market.slots} emplacements` : 'absent');

  // --- On se donne de quoi vendre : les pieces d'or du sac partent en bourse,
  //     et on ramasse ce qui traine. A defaut, on vend un objet du sac.
  seller.socket.emit('market:cash');
  await wait(250);
  const afterCash = seller.gold;
  check('pieces d\'or converties en bourse (ou sac vide de pieces)',
    afterCash >= CONFIG.MARKET.startingGold, `${afterCash} or`);

  // --- Refus : artefact de classe ---------------------------------------
  const artifact = Classes.artifactsOf('mage')[0].id;
  seller.errors.length = 0;
  seller.socket.emit('market:list', { type: artifact, qty: 1, price: 100 });
  await wait(200);
  check('un artefact de classe ne peut pas etre vendu',
    /ne peut pas être mis en vente/.test(lastError(seller) || ''), lastError(seller));

  // --- Refus : prix hors bornes -----------------------------------------
  await walkToLoot(seller, 2);
  const type = sellableType(seller);
  check('le vendeur a de quoi mettre en vente', !!type, type || 'sac vide');

  seller.errors.length = 0;
  seller.socket.emit('market:list', { type, qty: 1, price: 0 });
  await wait(150);
  check('prix a zero refuse', /prix unitaire/.test(lastError(seller) || ''), lastError(seller));

  seller.socket.emit('market:list', { type, qty: 1, price: CONFIG.MARKET.maxPrice + 1 });
  await wait(150);
  check('prix au-dessus du plafond refuse', /prix unitaire/.test(lastError(seller) || ''));

  // --- Mise en vente reussie --------------------------------------------
  const before = count(seller, type);
  const PRICE = 37;
  buyer.changed = 0;
  seller.socket.emit('market:list', { type, qty: 1, price: PRICE });
  await wait(300);

  const listing = (seller.market.listings || []).find(l => l.type === type && l.price === PRICE);
  check('annonce creee au prix choisi par le vendeur', !!listing,
    listing ? `${listing.name} ×${listing.qty} à ${listing.price} or` : 'introuvable');
  check('objet sequestre : il quitte le sac du vendeur', count(seller, type) === before - 1,
    `${before} -> ${count(seller, type)}`);
  check('le vendeur est prevenu dans le canal Info', said(seller, 'en vente à'));
  check('les autres fenetres sont averties du changement', buyer.changed >= 1);

  // --- Refus : acheter sa propre annonce --------------------------------
  seller.errors.length = 0;
  seller.socket.emit('market:buy', { id: listing.id, qty: 1 });
  await wait(200);
  check('on ne peut pas acheter sa propre annonce',
    /propre annonce/.test(lastError(seller) || ''), lastError(seller));

  // --- Achat -------------------------------------------------------------
  buyer.socket.emit('market:browse');
  await wait(200);
  const buyerGold = buyer.gold;
  const buyerHad = count(buyer, type);
  const sellerGold = seller.gold;

  buyer.socket.emit('market:buy', { id: listing.id, qty: 1 });
  await wait(350);

  check('l\'acheteur recoit l\'objet', count(buyer, type) === buyerHad + 1,
    `${buyerHad} -> ${count(buyer, type)}`);
  check('l\'acheteur est debite du prix affiche', buyer.gold === buyerGold - PRICE,
    `${buyerGold} -> ${buyer.gold} or`);
  check('le vendeur est credite du meme montant', seller.gold === sellerGold + PRICE,
    `${sellerGold} -> ${seller.gold} or`);
  check('le vendeur est prevenu de la vente', said(seller, 'Vendu'));
  check('l\'annonce epuisee disparait',
    !(buyer.market.listings || []).some(l => l.id === listing.id));

  // --- Refus : bourse insuffisante --------------------------------------
  await walkToLoot(seller, 1);
  const dearType = sellableType(seller);
  const rich = Math.min(CONFIG.MARKET.maxPrice, buyer.gold + 10000);
  seller.socket.emit('market:list', { type: dearType, qty: 1, price: rich });
  await wait(250);
  const dear = seller.market.listings.find(l => l.price === rich);
  check('annonce hors de prix creee', !!dear, `${dearType} à ${rich} or`);
  buyer.errors.length = 0;
  buyer.socket.emit('market:buy', { id: dear.id, qty: 1 });
  await wait(250);
  check('achat refuse si la bourse ne suit pas',
    /il te manque/i.test(lastError(buyer) || ''), lastError(buyer));

  // --- Retrait d'annonce -------------------------------------------------
  const heldBefore = count(seller, dearType);
  seller.socket.emit('market:cancel', dear.id);
  await wait(300);
  check('retrait : l\'objet revient dans le sac', count(seller, dearType) === heldBefore + 1,
    `${heldBefore} -> ${count(seller, dearType)}`);
  check('l\'annonce retiree n\'est plus listee',
    !seller.market.listings.some(l => l.id === dear.id));

  seller.errors.length = 0;
  seller.socket.emit('market:cancel', dear.id);
  await wait(200);
  check('retirer deux fois la meme annonce est refuse',
    /n'existe plus/.test(lastError(seller) || ''), lastError(seller));

  // --- Vendeur deconnecte : il est paye quand meme -----------------------
  // C'est le point qui distingue l'hotel de vente de l'echange : l'or va sur
  // le COMPTE, pas dans le sac, donc la vente aboutit sans le vendeur.
  const soloToken = await register(`solo${stamp}`);
  const solo = await play(soloToken, 'voleur');
  await wait(300);
  await walkToLoot(solo, 1);
  const soloType = sellableType(solo);
  const soloGold = solo.gold;
  solo.socket.emit('market:list', { type: soloType, qty: 1, price: 11 });
  await wait(300);
  const soloListing = solo.market.listings.find(l => l.sellerName === solo.welcome.you.name);
  check('annonce du vendeur temoin creee', !!soloListing);

  solo.socket.close();
  await wait(500);

  buyer.errors.length = 0;
  buyer.socket.emit('market:buy', { id: soloListing.id, qty: 1 });
  await wait(400);
  check('achat possible alors que le vendeur est deconnecte',
    !buyer.errors.length, lastError(buyer));

  // Le vendeur revient : sa bourse doit avoir encaisse la vente.
  const soloBack = await play(soloToken, 'voleur');
  await wait(250);
  check('le vendeur deconnecte retrouve son or a la reconnexion',
    soloBack.gold === soloGold + 11, `${soloGold} -> ${soloBack.gold} or`);

  // --- Quota d'annonces ---------------------------------------------------
  // On depose une annonce a la fois, en reprenant du butin quand le sac se
  // vide, jusqu'a taper le plafond du compte.
  seller.errors.length = 0;
  for (let i = 0; i < CONFIG.MARKET.maxPerAccount * 3; i++) {
    let next = sellableType(seller);
    if (!next) { await walkToLoot(seller, 1, 60); next = sellableType(seller); }
    if (!next) { await wait(300); continue; }   // le butin met 4 s a retomber
    seller.socket.emit('market:list', { type: next, qty: 1, price: 9 });
    await wait(120);
    if (seller.errors.some(e => /annonces à la fois/.test(e))) break;
  }
  await wait(400);
  seller.socket.emit('market:browse');
  await wait(200);
  check('le quota d\'annonces par compte est tenu',
    seller.market.used <= CONFIG.MARKET.maxPerAccount,
    `${seller.market.used}/${seller.market.slots} utilisees`);
  check('le depassement de quota est explique',
    seller.errors.some(e => /annonces à la fois/.test(e)), lastError(seller));

  for (const c of [seller, buyer, soloBack]) c.socket.close();
  await wait(200);
  console.log(failures ? `\n${failures} test(s) en echec.` : '\nTout est vert.');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
