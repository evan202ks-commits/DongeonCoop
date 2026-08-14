// Couche reseau : connexion authentifiee, buffer de snapshots, mesure de latence.
export class Net {
  constructor() {
    this.socket = null;
    this.id = null;
    this.roomId = null;
    this.config = null;
    this.items = {};
    this.snapshots = [];     // historique pour l'interpolation
    this.clockOffset = 0;    // horloge serveur - horloge client
    this.ping = 0;
    this.onWelcome = () => {};
    this.onInventory = () => {};
    this.onEvent = () => {};
  }

  connect(token) {
    this.socket = io();
    const s = this.socket;

    s.on('connect', () => s.emit('join', { token }));

    s.on('welcome', (data) => {
      this.id = data.id;
      this.roomId = data.roomId;
      this.config = data.config;
      this.items = data.items || {};
      this.clockOffset = data.snapshot.t - Date.now();
      this.snapshots = [data.snapshot];
      this.onWelcome(data);
    });

    s.on('state', (snap) => {
      // Moyenne glissante de l'offset d'horloge pour lisser la derive.
      this.clockOffset += ((snap.t - Date.now()) - this.clockOffset) * 0.1;
      this.snapshots.push(snap);
      if (this.snapshots.length > 30) this.snapshots.shift();
    });

    s.on('inventory', (data) => this.onInventory(data));
    s.on('notice', (msg) => this.onEvent('notice', { msg }));
    s.on('auth:error', (msg) => this.onEvent('auth-error', { msg }));
    s.on('player:join', (p) => this.onEvent('join', p));
    s.on('player:leave', (p) => this.onEvent('leave', p));
    s.on('disconnect', () => this.onEvent('disconnect', {}));
    s.on('pong:check', (sentAt) => { this.ping = Date.now() - sentAt; });

    setInterval(() => s.connected && s.emit('ping:check', Date.now()), 2000);
  }

  sendInput(cmd) {
    if (this.socket && this.socket.connected) this.socket.emit('input', cmd);
  }

  dropSlot(index) {
    if (this.socket && this.socket.connected) this.socket.emit('inventory:drop', index);
  }

  requestSave() {
    if (this.socket && this.socket.connected) this.socket.emit('save');
  }

  get latest() {
    return this.snapshots[this.snapshots.length - 1] || null;
  }

  /** Les deux snapshots encadrant `time` (horloge serveur), pour interpoler entre elles. */
  framesAt(time) {
    const list = this.snapshots;
    for (let i = list.length - 1; i > 0; i--) {
      if (list[i - 1].t <= time && time <= list[i].t) {
        return { a: list[i - 1], b: list[i], t: (time - list[i - 1].t) / (list[i].t - list[i - 1].t || 1) };
      }
    }
    const last = this.latest;
    return last ? { a: last, b: last, t: 0 } : null;
  }
}
