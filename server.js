const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const CONFIG = require('./server/config');
const RoomManager = require('./server/RoomManager');
const Accounts = require('./server/accounts');
const Classes = require('./server/classes');
const { ITEMS } = require('./server/items');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const rooms = new RoomManager();
const accounts = new Accounts();
const online = new Map(); // accountId -> socket.id (un seul jeu par compte)

app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API comptes --------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  const result = await accounts.register(username, password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ token: result.token, profile: accounts.profile(result.user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const result = await accounts.login(username, password);
  if (result.error) return res.status(401).json({ error: result.error });
  res.json({ token: result.token, profile: accounts.profile(result.user) });
});

/** Reprise de session : le client garde son jeton et se reconnecte sans ressaisir. */
app.get('/api/me', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = accounts.verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Session expirée.' });
  res.json({ profile: accounts.profile(user) });
});

/** Catalogue des classes et de leurs artefacts : sert l'ecran de choix de classe. */
app.get('/api/classes', (req, res) => {
  res.json({ classes: Classes.publicCatalog(), slots: Classes.EQUIP_SLOTS, labels: Classes.SLOT_LABELS });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/stats', (req, res) => {
  res.json({
    rooms: rooms.all.map(r => ({ id: r.id, players: r.count, ground: r.ground.size })),
    online: online.size,
    accounts: Object.keys(accounts.users).length
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- Connexions temps reel ---------------------------------------------
function saveAndDetach(socketId, room) {
  const player = room && room.remove(socketId);
  if (!player) return null;
  accounts.save(player.accountId, player.classId, room.saveSnapshot(player));
  accounts.flush();
  online.delete(player.accountId);
  return player;
}

io.on('connection', (socket) => {
  let room = null;
  let accountId = null;

  socket.on('join', (payload = {}) => {
    if (room) return;

    const user = accounts.verifyToken(payload.token);
    if (!user) return socket.emit('auth:error', 'Session invalide, reconnecte-toi.');

    // La classe est choisie a chaque connexion : sans classe valide, pas d'entree en jeu.
    const classId = payload.classId;
    if (!Classes.isValidClass(classId)) {
      return socket.emit('auth:error', 'Choisis une classe avant d\'entrer sur le terrain.');
    }

    // Un compte ne peut pas etre en jeu deux fois : l'ancienne session est ejectee.
    const previous = online.get(user.id);
    if (previous && previous !== socket.id) {
      const other = io.sockets.sockets.get(previous);
      const otherRoom = rooms.all.find(r => r.players.has(previous));
      if (otherRoom) {
        saveAndDetach(previous, otherRoom);
        io.to(otherRoom.id).emit('player:leave', { id: previous, name: user.username });
      }
      if (other) {
        other.emit('auth:error', 'Ton compte vient d\'être connecté ailleurs.');
        other.disconnect(true);
      }
    }

    room = rooms.findAvailable();
    accountId = user.id;
    online.set(user.id, socket.id);
    accounts.markSession(user.id, classId);

    const profile = accounts.gameProfile(user, classId);
    const player = room.add(socket.id, profile);
    socket.join(room.id);

    socket.emit('welcome', {
      id: socket.id,
      roomId: room.id,
      config: CONFIG,
      items: ITEMS,
      classes: Classes.publicCatalog(),
      equipSlots: Classes.EQUIP_SLOTS,
      slotLabels: Classes.SLOT_LABELS,
      you: {
        x: player.x, y: player.y, angle: player.angle,
        color: player.color, name: player.name,
        classId: player.classId, attrs: player.attrs,
        restored: player.restored, stats: player.stats
      },
      inventory: player.inventory.toJSON(),
      equipment: player.equipment,
      snapshot: room.snapshot()
    });

    socket.to(room.id).emit('player:join', {
      id: player.id, name: player.name, color: player.color,
      classId: player.classId, restored: player.restored
    });
  });

  socket.on('input', (cmd) => {
    if (room) room.queueInput(socket.id, cmd);
  });

  socket.on('inventory:drop', (slot) => {
    if (room) room.dropItem(socket.id, slot);
  });

  socket.on('equip', (type) => {
    if (room) room.equip(socket.id, String(type || ''));
  });

  socket.on('unequip', (slot) => {
    if (room) room.unequip(socket.id, String(slot || ''));
  });

  /** Sauvegarde manuelle demandee par le client (fermeture d'onglet, bouton). */
  socket.on('save', () => {
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) accounts.save(player.accountId, player.classId, room.saveSnapshot(player));
  });

  socket.on('ping:check', (sentAt) => socket.emit('pong:check', sentAt));

  socket.on('disconnect', () => {
    if (!room) return;
    const player = saveAndDetach(socket.id, room);
    if (player) io.to(room.id).emit('player:leave', { id: socket.id, name: player.name });
    rooms.cleanup(room.id);
    room = null;
    accountId = null;
  });
});

// --- Boucles serveur ----------------------------------------------------
const tickMs = 1000 / CONFIG.TICK_HZ;
let last = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  for (const room of rooms.all) {
    room.step(dt);

    for (const event of room.drainEvents()) {
      const player = room.players.get(event.playerId);
      if (!player) continue;
      if (event.type === 'pickup' || event.type === 'inventory' || event.type === 'equip') {
        io.to(event.playerId).emit('inventory', {
          slots: player.inventory.toJSON(),
          equipment: player.equipment,
          attrs: player.attrs,
          picked: event.item && event.type === 'pickup' ? event.item : null,
          equipped: event.type === 'equip' ? event.item : undefined,
          stats: player.stats
        });
      } else if (event.type === 'full') {
        io.to(event.playerId).emit('notice', 'Inventaire plein.');
      } else if (event.type === 'notice') {
        io.to(event.playerId).emit('notice', event.msg);
      }
    }
  }
}, tickMs);

setInterval(() => {
  for (const room of rooms.all) {
    if (room.count > 0) io.to(room.id).emit('state', room.snapshot());
  }
}, 1000 / CONFIG.SNAPSHOT_HZ);

// Autosave : on n'attend pas la deconnexion propre pour ecrire sur les comptes.
setInterval(() => {
  for (const room of rooms.all) {
    for (const player of room.players.values()) {
      accounts.save(player.accountId, player.classId, room.saveSnapshot(player));
    }
  }
  accounts.flush();
}, CONFIG.SAVE.autosaveMs);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur demarre sur le port ${PORT}`);
});
