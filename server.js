const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const CONFIG = require('./server/config');
const RoomManager = require('./server/RoomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const rooms = new RoomManager();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/stats', (req, res) => {
  res.json({
    rooms: rooms.all.map(r => ({ id: r.id, players: r.count })),
    total: rooms.all.reduce((n, r) => n + r.count, 0)
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Connexions ---------------------------------------------------------
io.on('connection', (socket) => {
  let room = null;

  socket.on('join', (payload = {}) => {
    if (room) return;

    room = rooms.findAvailable();
    const player = room.add(socket.id, payload.name);
    socket.join(room.id);

    // Etat initial : config du terrain + joueurs deja presents.
    socket.emit('welcome', {
      id: socket.id,
      roomId: room.id,
      config: CONFIG,
      you: { x: player.x, y: player.y, angle: player.angle, color: player.color, name: player.name },
      dropUntil: player.dropUntil,
      snapshot: room.snapshot()
    });

    socket.to(room.id).emit('player:join', {
      id: player.id, name: player.name, color: player.color,
      x: player.x, y: player.y, dropUntil: player.dropUntil
    });
  });

  socket.on('input', (cmd) => {
    if (!room) return;
    room.queueInput(socket.id, cmd);
  });

  // Mesure de latence cote client.
  socket.on('ping:check', (sentAt) => socket.emit('pong:check', sentAt));

  socket.on('disconnect', () => {
    if (!room) return;
    const player = room.remove(socket.id);
    if (player) io.to(room.id).emit('player:leave', { id: socket.id, name: player.name });
    rooms.cleanup(room.id);
    room = null;
  });
});

// --- Boucles serveur ----------------------------------------------------
const tickMs = 1000 / CONFIG.TICK_HZ;
let last = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  for (const r of rooms.all) r.step(dt);
}, tickMs);

setInterval(() => {
  for (const r of rooms.all) {
    if (r.count > 0) io.to(r.id).emit('state', r.snapshot());
  }
}, 1000 / CONFIG.SNAPSHOT_HZ);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur demarre sur le port ${PORT}`);
});
