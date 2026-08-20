// Fenetre de discussion facon Dofus : onglets filtrants, selecteur de canal,
// commandes (/w /c /r /me), historique de saisie, bulles au-dessus des tetes.
// Le serveur reste maitre du canal et de la cadence ; ici on ne fait qu'afficher.

const TABS = [
  { id: 'tout',     label: 'Tout',      channels: null },
  { id: 'general',  label: 'Général',   channels: ['general', 'erreur'] },
  { id: 'commerce', label: 'Commerce',  channels: ['commerce', 'recrutement'] },
  { id: 'prive',    label: 'Privé',     channels: ['prive'] },
  { id: 'info',     label: 'Info',      channels: ['info', 'erreur'] }
];

const el = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export class Chat {
  constructor() {
    this.channels = {};
    this.speakable = [];
    this.current = 'general';
    this.tab = 'tout';
    this.messages = [];
    this.history = [];        // saisies precedentes, rappelees avec ↑ / ↓
    this.historyIndex = -1;
    this.draft = '';
    this.lastWhisper = null;  // dernier interlocuteur prive, pour la reponse rapide
    this.bubbles = new Map(); // fromId -> { text, until }
    this.bubbleMs = 6500;
    this.unread = new Map();
    this.replaying = false;
    this.selfId = null;
    this.selfName = '';
    this.roster = [];
    this.onSend = () => {};
    this.ready = false;

    this.root = el('chat');
    this.body = el('chatBody');
    this.input = el('chatInput');
    this.tabsBar = el('chatTabs');
    this.channelBtn = el('chatChannel');

    this.bindShell();
  }

  // --- Mise en place -----------------------------------------------------
  setup({ channels, selfId, selfName, bubbleMs, onSend }) {
    this.channels = channels || {};
    this.speakable = Object.values(this.channels).filter(c => c.speakable).map(c => c.id);
    this.selfId = selfId;
    this.selfName = selfName;
    if (bubbleMs) this.bubbleMs = bubbleMs;
    this.onSend = onSend;
    this.ready = true;

    if (!this.speakable.includes(this.current)) this.current = this.speakable[0];
    this.root.hidden = false;
    this.drawTabs();
    this.drawChannel();
  }

  bindShell() {
    // Onglets
    this.tabsBar.innerHTML = '';
    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-tab' + (tab.id === this.tab ? ' active' : '');
      btn.dataset.tab = tab.id;
      btn.innerHTML = `<span>${tab.label}</span><i class="chat-dot"></i>`;
      btn.addEventListener('click', () => this.setTab(tab.id));
      this.tabsBar.appendChild(btn);
    }

    el('chatSend').addEventListener('click', () => this.submit());
    this.channelBtn.addEventListener('click', () => this.cycleChannel());

    el('chatToggle').addEventListener('click', () => {
      this.root.classList.toggle('collapsed');
      el('chatToggle').textContent = this.root.classList.contains('collapsed') ? '▲' : '▬';
    });

    this.input.addEventListener('focus', () => this.root.classList.add('focused'));
    this.input.addEventListener('blur', () => this.root.classList.remove('focused'));

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.input.blur(); }
      else if (e.key === 'Tab') { e.preventDefault(); this.cycleChannel(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.recall(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.recall(-1); }
      e.stopPropagation();          // aucune touche du chat ne doit atteindre le jeu
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());

    // Entrée n'importe où dans le jeu = prendre la parole (comme dans Dofus).
    window.addEventListener('keydown', (e) => {
      if (!this.ready || this.isTyping()) return;
      if (e.key === 'Enter') { e.preventDefault(); this.focus(); }
      else if (e.key === '/') { e.preventDefault(); this.focus('/'); }
    });

    this.bindResize();
  }

  /** Poignee haute : on tire pour agrandir la fenetre, comme le chat de Dofus. */
  bindResize() {
    const handle = el('chatResize');
    let startY = 0, startH = 0, active = false;

    const move = (e) => {
      if (!active) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const h = Math.max(110, Math.min(window.innerHeight - 160, startH + (startY - y)));
      this.root.style.setProperty('--chat-h', `${h}px`);
      e.preventDefault();
    };
    const stop = () => { active = false; };
    const start = (e) => {
      active = true;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startH = this.body.getBoundingClientRect().height;
      e.preventDefault();
    };

    handle.addEventListener('mousedown', start);
    handle.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
  }

  // --- Etat --------------------------------------------------------------
  isTyping() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  }

  focus(prefill) {
    if (this.root.classList.contains('collapsed')) {
      this.root.classList.remove('collapsed');
      el('chatToggle').textContent = '▬';
    }
    if (prefill) this.input.value = prefill;
    this.input.focus();
  }

  setTab(id) {
    this.tab = id;
    this.unread.set(id, 0);
    for (const btn of this.tabsBar.children) {
      btn.classList.toggle('active', btn.dataset.tab === id);
      if (btn.dataset.tab === id) btn.classList.remove('unread');
    }
    this.render();
  }

  cycleChannel() {
    const list = this.speakable;
    if (!list.length) return;
    const next = list[(list.indexOf(this.current) + 1) % list.length];
    this.current = next;
    this.drawChannel();
    this.input.focus();
  }

  drawChannel() {
    const ch = this.channels[this.current];
    if (!ch) return;
    this.channelBtn.textContent = ch.label;
    this.channelBtn.style.color = ch.color;
    this.channelBtn.style.borderColor = ch.color;
    this.channelBtn.title = `${ch.hint} — Tab pour changer de canal`;
    this.input.placeholder = ch.id === 'prive'
      ? 'pseudo message  (ou /w pseudo message)'
      : `Parler dans ${ch.label}…`;
  }

  drawTabs() {
    for (const btn of this.tabsBar.children) {
      btn.classList.toggle('active', btn.dataset.tab === this.tab);
    }
  }

  // --- Reception ---------------------------------------------------------
  push(msg) {
    if (!msg || !msg.text) return;
    this.messages.push(msg);
    if (this.messages.length > 200) this.messages.shift();

    // Bulle au-dessus du personnage : uniquement pour ce qui se dit dans la salle,
    // et jamais pour les messages d'avant la connexion.
    if (!this.replaying && msg.ch === 'general' && msg.fromId) {
      this.bubbles.set(msg.fromId, { text: msg.text, until: performance.now() + this.bubbleMs, kind: msg.kind });
    }
    if (msg.ch === 'prive' && msg.fromId) {
      this.lastWhisper = msg.fromId === this.selfId ? msg.to : msg.from;
    }

    if (!this.replaying) this.markUnread(msg);
    if (this.visible(msg)) this.append(msg, true);
  }

  /** Messages deja echanges avant l'arrivee : affiches, mais sans bulle ni pastille. */
  replay(history = []) {
    this.replaying = true;
    for (const msg of history) this.push(msg);
    this.replaying = false;
    this.body.scrollTop = this.body.scrollHeight;
  }

  /** Message local (jamais renvoye au serveur) : aide, /who, pertes de connexion. */
  system(text, ch = 'info') {
    this.push({ id: `local-${Math.random()}`, t: Date.now(), ch, kind: 'system', text });
  }

  markUnread(msg) {
    for (const tab of TABS) {
      if (tab.id === this.tab) continue;
      if (tab.channels && !tab.channels.includes(msg.ch)) continue;
      this.unread.set(tab.id, (this.unread.get(tab.id) || 0) + 1);
      const btn = [...this.tabsBar.children].find(b => b.dataset.tab === tab.id);
      if (btn) btn.classList.add('unread');
    }
  }

  visible(msg) {
    const tab = TABS.find(t => t.id === this.tab);
    return !tab.channels || tab.channels.includes(msg.ch);
  }

  render() {
    this.body.innerHTML = '';
    for (const msg of this.messages) {
      if (this.visible(msg)) this.append(msg, false);
    }
    this.body.scrollTop = this.body.scrollHeight;
  }

  /** Une ligne de chat. Tout passe par textContent : aucun HTML injectable. */
  append(msg, autoscroll) {
    const ch = this.channels[msg.ch] || { color: '#cbd5e1', short: '?' };
    const stuck = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;

    const line = document.createElement('div');
    line.className = `chat-line ch-${msg.ch}${msg.kind === 'emote' ? ' emote' : ''}`;
    line.style.setProperty('--ch', ch.color);

    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = clock(msg.t);
    line.appendChild(time);

    if (msg.kind === 'system') {
      const text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = msg.text;
      line.appendChild(text);
    } else if (msg.kind === 'emote') {
      const text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = `${msg.from} ${msg.text}`;
      line.appendChild(text);
    } else {
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'chat-name';

      if (msg.ch === 'prive') {
        const outgoing = msg.fromId === this.selfId;
        const other = outgoing ? msg.to : msg.from;
        name.textContent = outgoing ? `à ${other}` : `de ${other}`;
        name.title = `Chuchoter à ${other}`;
        name.addEventListener('click', () => this.whisperTo(other));
      } else {
        name.textContent = msg.from;
        name.title = `Chuchoter à ${msg.from}`;
        name.addEventListener('click', () => this.whisperTo(msg.from));
      }
      if (msg.fromId === this.selfId) name.classList.add('me');

      const colon = document.createElement('span');
      colon.className = 'chat-sep';
      colon.textContent = ' : ';

      const text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = msg.text;

      line.append(name, colon, text);
    }

    this.body.appendChild(line);
    while (this.body.children.length > 200) this.body.removeChild(this.body.firstChild);
    if (autoscroll && stuck) this.body.scrollTop = this.body.scrollHeight;
  }

  whisperTo(name) {
    if (!name || name === this.selfName) return;
    this.current = 'prive';
    this.drawChannel();
    this.input.value = `/w ${name} `;
    this.focus();
  }

  // --- Saisie ------------------------------------------------------------
  recall(direction) {
    if (!this.history.length) return;
    if (this.historyIndex === -1) this.draft = this.input.value;
    this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex + direction));
    this.input.value = this.historyIndex === -1 ? this.draft : this.history[this.historyIndex];
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  submit() {
    const raw = this.input.value.trim();
    if (!raw) { this.input.blur(); return; }

    this.history.unshift(raw);
    if (this.history.length > 40) this.history.pop();
    this.historyIndex = -1;
    this.draft = '';
    this.input.value = '';

    const parsed = this.parse(raw);
    this.input.blur();                         // la main revient au personnage
    if (!parsed) return;                       // commande locale deja traitee
    this.onSend(parsed);
  }

  /**
   * Traduit une saisie en { channel, text, to }.
   * Renvoie null pour les commandes purement locales (/help, /who, /clear).
   */
  parse(raw) {
    const cmd = raw.match(/^\/(\w+)\s*([\s\S]*)$/);

    if (cmd) {
      const key = cmd[1].toLowerCase();
      const rest = cmd[2].trim();

      if (key === 'help' || key === 'aide' || key === '?') return this.showHelp();
      if (key === 'who' || key === 'qui') return this.showWho();
      if (key === 'clear' || key === 'vider') { this.messages = []; this.render(); return null; }
      if (key === 'me') {
        if (!rest) return null;
        return { channel: 'general', text: `/me ${rest}` };
      }
      if (key === 'w' || key === 'm' || key === 'mp') {
        const parts = rest.match(/^(\S+)\s+([\s\S]+)$/);
        if (!parts) { this.system('Usage : /w pseudo message', 'erreur'); return null; }
        this.current = 'prive';
        this.drawChannel();
        return { channel: 'prive', to: parts[1], text: parts[2] };
      }
      if (key === 'rep' || key === 'r2') {
        if (!this.lastWhisper) { this.system('Personne à qui répondre.', 'erreur'); return null; }
        if (!rest) return null;
        return { channel: 'prive', to: this.lastWhisper, text: rest };
      }

      // Canal declare par sa commande : /g /s /c /r
      const target = Object.values(this.channels).find(c => (c.cmds || []).includes(key) && c.speakable);
      if (target) {
        this.current = target.id;
        this.drawChannel();
        if (!rest) return null;                // "/c" seul = simple changement de canal
        return { channel: target.id, text: rest };
      }

      this.system(`Commande inconnue : /${key} — tape /help.`, 'erreur');
      return null;
    }

    // Pas de commande : le canal courant decide.
    if (this.current === 'prive') {
      const parts = raw.match(/^(\S+)\s+([\s\S]+)$/);
      if (parts) return { channel: 'prive', to: parts[1], text: parts[2] };
      if (this.lastWhisper) return { channel: 'prive', to: this.lastWhisper, text: raw };
      this.system('Canal privé : écris "pseudo message" ou utilise /w.', 'erreur');
      return null;
    }
    return { channel: this.current, text: raw };
  }

  showHelp() {
    this.system('Commandes : /g général · /c commerce · /r recrutement · /w pseudo message · /rep réponse · /me action · /who · /clear');
    this.system('Entrée pour parler, Tab pour changer de canal, ↑ ↓ pour retrouver tes messages, clic sur un pseudo pour chuchoter.');
    return null;
  }

  showWho() {
    if (!this.roster.length) { this.system('Personne d\'autre dans la salle.'); return null; }
    this.system(`Dans la salle (${this.roster.length}) : ${this.roster.map(p => p.name).join(', ')}`);
    return null;
  }

  // --- Bulles ------------------------------------------------------------
  bubbleFor(id) {
    const b = this.bubbles.get(id);
    if (!b) return null;
    if (performance.now() > b.until) { this.bubbles.delete(id); return null; }
    return b;
  }
}
