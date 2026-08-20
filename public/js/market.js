// Hotel de vente cote client : trois onglets (acheter, vendre, mes annonces).
// La fenetre n'est qu'un miroir — c'est le serveur qui detient les annonces,
// la bourse et les inventaires. Rien n'est decide ici, tout est revalide la-bas.

const el = (id) => document.getElementById(id);

export class Market {
  constructor() {
    this.open = false;
    this.tab = 'buy';
    this.state = null;        // dernier market:state recu
    this.selected = null;     // type d'objet choisi dans l'onglet Vendre
    this.search = '';
    this.accountId = null;
    this.itemDef = () => ({ name: '?', color: '#94a3b8' });
    this.bag = () => [];      // fourni par main.js : cases du sac
    this.onSend = {};

    this.modal = el('marketModal');
    this.bindShell();
  }

  setup({ accountId, itemDef, bag, actions }) {
    this.accountId = accountId;
    this.itemDef = itemDef;
    this.bag = bag;
    this.onSend = actions;
  }

  bindShell() {
    el('marketBtn').addEventListener('click', () => this.toggle());
    el('marketCloseBtn').addEventListener('click', () => this.close());
    this.modal.addEventListener('mousedown', (e) => { if (e.target === this.modal) this.close(); });

    for (const btn of document.querySelectorAll('.market-tab')) {
      btn.addEventListener('click', () => this.setTab(btn.dataset.tab));
    }

    el('marketSearch').addEventListener('input', (e) => {
      this.search = e.target.value.trim().toLowerCase();
      this.drawListings();
    });

    el('marketQty').addEventListener('input', () => this.drawTotal());
    el('marketPrice').addEventListener('input', () => this.drawTotal());
    el('marketSellBtn').addEventListener('click', () => this.sell());
    el('marketCashBtn').addEventListener('click', () => this.onSend.cash());
  }

  // --- Ouverture ---------------------------------------------------------
  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    this.open = true;
    this.modal.hidden = false;
    this.error('');
    this.onSend.browse();      // on repart toujours de l'etat serveur
    this.draw();
  }

  close() {
    this.open = false;
    this.modal.hidden = true;
  }

  setTab(tab) {
    this.tab = tab;
    for (const btn of document.querySelectorAll('.market-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    }
    el('marketPaneBuy').hidden = tab !== 'buy';
    el('marketPaneSell').hidden = tab !== 'sell';
    el('marketPaneMine').hidden = tab !== 'mine';
    this.error('');
    this.draw();
  }

  error(msg) {
    el('marketError').textContent = msg || '';
  }

  // --- Reception --------------------------------------------------------
  apply(type, data) {
    if (type === 'state') {
      this.state = data;
      el('gold').textContent = data.gold;
      if (this.open) this.draw();
    } else if (type === 'purse') {
      el('gold').textContent = data.gold;
      if (this.state) this.state.gold = data.gold;
      if (this.open) this.draw();
    } else if (type === 'changed') {
      // Un autre joueur a bouge le marche : on ne rafraichit que si la fenetre
      // est ouverte, inutile de tirer des annonces qu'on ne regarde pas.
      if (this.open) this.onSend.browse();
    } else if (type === 'error') {
      this.error(data.msg);
    }
  }

  /** Le sac a change (achat, retrait, depot) : l'onglet Vendre doit suivre. */
  refreshBag() {
    if (this.open && this.tab === 'sell') this.drawBag();
  }

  // --- Rendu ------------------------------------------------------------
  draw() {
    if (!this.state) return;
    el('marketGold').textContent = this.state.gold;
    el('gold').textContent = this.state.gold;
    el('marketMineCount').textContent = `(${this.state.used}/${this.state.slots})`;

    if (this.tab === 'buy') this.drawListings();
    else if (this.tab === 'sell') this.drawBag();
    else this.drawMine();
  }

  gem(def) {
    const gem = document.createElement('span');
    gem.className = 'gem';
    if (def.icon) {
      gem.classList.add('icon');
      gem.style.backgroundImage = `url(${def.icon})`;
    } else {
      gem.style.background = def.color;
    }
    return gem;
  }

  row(def, title, subtitle) {
    const row = document.createElement('div');
    row.className = 'market-row';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = title;
    if (subtitle) {
      const small = document.createElement('small');
      small.textContent = subtitle;
      name.appendChild(small);
    }
    row.append(this.gem(def), name);
    return row;
  }

  empty(target, text) {
    target.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'market-empty';
    div.textContent = text;
    target.appendChild(div);
  }

  /** Onglet Acheter : toutes les annonces, les siennes grisees et non achetables. */
  drawListings() {
    const target = el('marketListings');
    const all = this.state.listings.filter(l => {
      if (!this.search) return true;
      return l.name.toLowerCase().includes(this.search)
          || l.sellerName.toLowerCase().includes(this.search);
    });

    if (!all.length) {
      return this.empty(target, this.search ? 'Aucune annonce ne correspond.' : 'Aucune annonce en vente pour le moment.');
    }

    target.innerHTML = '';
    for (const listing of all) {
      const def = this.itemDef(listing.type);
      const mine = listing.sellerId === this.accountId;
      const row = this.row(def, `${listing.name} ×${listing.qty}`, `Vendu par ${listing.sellerName}`);
      if (mine) row.classList.add('own');

      const price = document.createElement('div');
      price.className = 'price';
      price.innerHTML = `${listing.price} or <small>/ unité</small>`;
      row.appendChild(price);

      if (mine) {
        const tag = document.createElement('span');
        tag.className = 'market-hint-inline';
        tag.textContent = 'ton annonce';
        row.appendChild(tag);
      } else {
        const qty = document.createElement('input');
        qty.type = 'number';
        qty.min = 1;
        qty.max = listing.qty;
        qty.value = 1;
        qty.title = 'Quantité à acheter';

        const buy = document.createElement('button');
        buy.type = 'button';
        buy.className = 'mini buy';
        const refresh = () => {
          const n = Math.max(1, Math.min(listing.qty, Math.floor(Number(qty.value) || 1)));
          buy.textContent = `Acheter · ${n * listing.price} or`;
          buy.disabled = n * listing.price > this.state.gold;
        };
        qty.addEventListener('input', refresh);
        refresh();

        buy.addEventListener('click', () => {
          const n = Math.max(1, Math.min(listing.qty, Math.floor(Number(qty.value) || 1)));
          this.error('');
          this.onSend.buy(listing.id, n);
        });
        row.append(qty, buy);
      }
      target.appendChild(row);
    }
  }

  /** Onglet Vendre : le sac, regroupe par type, artefacts exclus. */
  drawBag() {
    const target = el('marketBag');
    const counts = new Map();
    for (const slot of this.bag()) {
      if (!slot) continue;
      const def = this.itemDef(slot.type);
      if (def.artifact) continue;           // lie au personnage, jamais vendable
      counts.set(slot.type, (counts.get(slot.type) || 0) + slot.qty);
    }

    if (!counts.size) {
      this.selected = null;
      el('marketForm').hidden = true;
      return this.empty(target, 'Rien de vendable dans ton sac.');
    }
    if (this.selected && !counts.has(this.selected)) this.selected = null;

    target.innerHTML = '';
    for (const [type, total] of counts) {
      const def = this.itemDef(type);
      const row = this.row(def, `${def.name} ×${total}`, def.value ? `Valeur indicative ${def.value} or` : '');
      row.classList.add('selectable');
      if (this.selected === type) row.classList.add('selected');
      row.addEventListener('click', () => this.select(type, total));
      target.appendChild(row);
    }

    if (this.selected) this.select(this.selected, counts.get(this.selected), true);
    else el('marketForm').hidden = true;
  }

  select(type, available, keepValues = false) {
    this.selected = type;
    const def = this.itemDef(type);

    el('marketForm').hidden = false;
    el('marketFormName').textContent = `${def.name} — ${available} en sac`;
    const gem = el('marketFormGem');
    gem.className = 'gem';
    if (def.icon) { gem.classList.add('icon'); gem.style.backgroundImage = `url(${def.icon})`; }
    else { gem.style.backgroundImage = 'none'; gem.style.background = def.color; }

    const qty = el('marketQty');
    qty.max = available;
    if (!keepValues) {
      qty.value = 1;
      // Prix conseille, jamais impose : le vendeur reste maitre de son prix.
      el('marketPrice').value = def.value || 1;
    }
    if (Number(qty.value) > available) qty.value = available;
    el('marketPrice').max = this.state ? this.state.maxPrice : 99999;
    el('marketSuggest').textContent = def.value ? `valeur indicative ${def.value} or l'unité` : '';

    if (!keepValues) {
      for (const row of el('marketBag').children) row.classList.remove('selected');
      this.drawBag();
    }
    this.drawTotal();
  }

  drawTotal() {
    const qty = Math.max(1, Math.floor(Number(el('marketQty').value) || 1));
    const price = Math.max(0, Math.floor(Number(el('marketPrice').value) || 0));
    el('marketTotal').textContent = qty * price;
  }

  sell() {
    if (!this.selected) return this.error('Choisis un objet dans ton sac.');
    const qty = Math.max(1, Math.floor(Number(el('marketQty').value) || 1));
    const price = Math.floor(Number(el('marketPrice').value) || 0);
    if (price < 1) return this.error('Fixe un prix unitaire d\u2019au moins 1 or.');
    this.error('');
    this.onSend.list(this.selected, qty, price);
  }

  /** Onglet Mes annonces : retrait possible tant que personne n'a acheté. */
  drawMine() {
    const target = el('marketMine');
    const mine = this.state.listings.filter(l => l.sellerId === this.accountId);
    if (!mine.length) {
      return this.empty(target, `Aucune annonce en cours (${this.state.slots} emplacements disponibles).`);
    }

    target.innerHTML = '';
    for (const listing of mine) {
      const def = this.itemDef(listing.type);
      const row = this.row(def, `${listing.name} ×${listing.qty}`, `${listing.price} or l'unité`);

      const price = document.createElement('div');
      price.className = 'price';
      price.innerHTML = `${listing.total} or <small>au total</small>`;

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'mini decline';
      cancel.textContent = 'Retirer';
      cancel.addEventListener('click', () => { this.error(''); this.onSend.cancel(listing.id); });

      row.append(price, cancel);
      target.appendChild(row);
    }
  }
}
