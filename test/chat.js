/**
 * Tests de fumee du chat : canaux, portee (salle vs serveur), chuchotements,
 * anti-flood, historique a la connexion.
 * Lancer le serveur puis :  node test/chat.js
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
    const client = { socket, chat: [], welcome: null };
    socket.on('welcome', (d) => { client.welcome = d; resolve(client); });
    socket.on('chat:message', (m) => client.chat.push(m));
    socket.on('connect', () => socket.emit('join', { token, classId }));
  });
}

const said = (c, text) => c.chat.some(m => m.text === text);
const inChannel = (c, ch, text) => c.chat.some(m => m.ch === ch && m.text === text);

(async () => {
  const stamp = Date.now().toString(36).slice(-5);
  const names = [`alpha${stamp}`, `beta${stamp}`, `gamma${stamp}`];
  const tokens = [];
  for (const n of names) tokens.push(await register(n));

  const a = await play(tokens[0], 'mage');
  const b = await play(tokens[1], 'archer');
  await wait(150);

  check('catalogue de canaux envoye au welcome',
    !!a.welcome.channels && !!a.welcome.channels.general && !!a.welcome.channels.prive,
    Object.keys(a.welcome.channels || {}).join(','));
  check('historique de salle envoye au welcome', Array.isArray(a.welcome.chatHistory));
  check('arrivee annoncee dans le canal Info',
    a.chat.some(m => m.ch === 'info' && m.text.includes(names[1])));

  // --- General : visible par la salle ---
  a.socket.emit('chat:send', { channel: 'general', text: 'salut la salle' });
  await wait(120);
  check('general recu par l\'autre joueur', inChannel(b, 'general', 'salut la salle'));
  check('general renvoye a l\'auteur', inChannel(a, 'general', 'salut la salle'));

  // --- Commerce : tout le serveur ---
  b.socket.emit('chat:send', { channel: 'commerce', text: 'vends cristal 100k' });
  await wait(120);
  check('commerce diffuse a tout le serveur', inChannel(a, 'commerce', 'vends cristal 100k'));

  // --- Prive : uniquement les deux interlocuteurs ---
  const c = await play(tokens[2], 'voleur');
  await wait(150);
  a.socket.emit('chat:send', { channel: 'prive', to: names[1], text: 'rendez-vous au brasier' });
  await wait(120);
  check('prive recu par la cible', inChannel(b, 'prive', 'rendez-vous au brasier'));
  check('prive visible par l\'expediteur', inChannel(a, 'prive', 'rendez-vous au brasier'));
  check('prive invisible pour les autres', !said(c, 'rendez-vous au brasier'));

  a.socket.emit('chat:send', { channel: 'prive', to: 'personne-du-tout', text: 'coucou' });
  await wait(120);
  check('cible inconnue refusee', a.chat.some(m => m.ch === 'erreur' && m.text.includes('connecté')));

  // --- Commande brute laissee dans le texte ---
  c.chat.length = 0;
  a.socket.emit('chat:send', { channel: 'general', text: `/w ${names[2]} commande brute` });
  await wait(120);
  check('commande /w dans le texte resolue', inChannel(c, 'prive', 'commande brute'));

  // --- Canal interdit ---
  a.socket.emit('chat:send', { channel: 'info', text: 'je suis le serveur' });
  await wait(100);
  check('canal systeme refuse au joueur', !said(b, 'je suis le serveur'));

  // --- Longueur ---
  const longText = 'x'.repeat(CONFIG.CHAT.maxLength + 120);
  b.chat.length = 0;
  c.socket.emit('chat:send', { channel: 'general', text: longText });
  await wait(120);
  const long = b.chat.find(m => m.ch === 'general' && m.text.startsWith('xxx'));
  check('message tronque a la longueur max', !!long && long.text.length === CONFIG.CHAT.maxLength,
    long ? `${long.text.length} car.` : 'aucun message');

  // --- Anti-flood ---
  a.chat.length = 0;
  for (let i = 0; i < CONFIG.CHAT.burst + 6; i++) {
    a.socket.emit('chat:send', { channel: 'general', text: `flood ${i}` });
  }
  await wait(250);
  const passed = a.chat.filter(m => m.ch === 'general' && m.text.startsWith('flood')).length;
  check('anti-flood limite la rafale', passed <= CONFIG.CHAT.burst + 1, `${passed} messages passes`);
  check('avertissement de flood envoye', a.chat.some(m => m.ch === 'erreur'));

  // --- Historique servi au joueur suivant ---
  const d = await play(await register(`delta${stamp}`), 'barbare');
  await wait(200);
  check('historique rejoue a la connexion',
    (d.welcome.chatHistory || []).some(m => m.text === 'salut la salle'),
    `${(d.welcome.chatHistory || []).length} messages`);

  for (const client of [a, b, c, d]) client.socket.close();
  await wait(200);
  console.log(failures ? `\n${failures} test(s) en echec.` : '\nTout est vert.');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
