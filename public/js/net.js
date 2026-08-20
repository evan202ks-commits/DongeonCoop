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
    this.onTrade = () => {};
    this.onChat = () => {};
  }

  connect(token, classId) {
    this.socket = io();
    this.classId = classId;
    const s = this.socket;

    // La classe part a chaque (re)connexion : le serveur refuse une entree sans elle.
    s.on('connect', () => s.emit('join', { token, classId }));

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
    s.on('chat:message', (msg) => this.onChat(msg));
    s.on('notice', (msg) => this.onEvent('notice', { msg }));
    s.on('auth:error', (msg) => this.onEvent('auth-error', { msg }));
    s.on('door:open', (d) => this.onEvent('door', d));
    s.on('player:join', (p) => this.onEvent('join', p));
    s.on('player:leave', (p) => this.onEvent('leave', p));
    s.on('disconnect', () => this.onEvent('disconnect', {}));
    s.on('pong:check', (sentAt) => { this.ping = Date.now() - sentAt; });

    // --- Echanges entre comptes ---
    s.on('trade:incoming', (data) => this.onTrade('incoming', data));
    s.on('trade:start', (data) => this.onTrade('start', data));
    s.on('trade:update', (data) => this.onTrade('update', data));
    s.on('trade:cancelled', (data) => this.onTrade('cancelled', data));
    s.on('trade:done', (data) => this.onTrade('done', data));
    s.on('trade:error', (msg) => this.onTrade('error', { msg }));
    s.on('trade:notice', (msg) => this.onTrade('notice', { msg }));

    setInterval(() => s.connected && s.emit('ping:check', Date.now()), 2000);
  }

  /** Envoi d'un message : { channel, text, to } — le serveur revalide tout. */
  sendChat(payload) {
    if (this.socket && this.socket.connected) this.socket.emit('chat:send', payload);
  }

  sendInput(cmd) {
    if (this.socket && this.socket.connected) this.socket.emit('input', cmd);
  }

  dropSlot(index) {
    if (this.socket && this.socket.connected) this.socket.emit('inventory:drop', index);
  }

  equip(type) {
    if (this.socket && this.socket.connected) this.socket.emit('equip', type);
  }

  unequip(slot) {
    if (this.socket && this.socket.connected) this.socket.emit('unequip', slot);
  }

  requestSave() {
    if (this.socket && this.socket.connected) this.socket.emit('save');
  }

  // --- Echanges entre comptes ---
  tradeRequest(targetId) {
    if (this.socket && this.socket.connected) this.socket.emit('trade:request', targetId);
  }

  tradeRespond(accept) {
    if (this.socket && this.socket.connected) this.socket.emit('trade:respond', accept);
  }

  tradeOffer(type, qty) {
    if (this.socket && this.socket.connected) this.socket.emit('trade:offer', { type, qty });
  }

  tradeConfirm() {
    if (this.socket && this.socket.connected) this.socket.emit('trade:confirm');
  }

  tradeCancel() {
    if (this.socket && this.socket.connected) this.socket.emit('trade:cancel');
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
