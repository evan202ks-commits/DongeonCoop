const path = require('path');
const CONFIG = require('./config');
const Store = require('./store');
const Inventory = require('./inventory');
const { ITEMS, isDroppable } = require('./items');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

/**
 * Hotel de vente : chacun depose ses objets au prix qu'il fixe lui-meme, les
 * autres achetent a ce prix. Il n'y a ni prix impose ni negociation — pour
 * marchander, il y a les echanges (server/trade.js).
 *
 * Deux principes tiennent tout le reste :
 *
 * 1. **Sequestre.** Mettre en vente retire immediatement les objets du sac.
 *    Ils vivent dans l'annonce, pas dans deux endroits a la fois : impossible
 *    de vendre le meme cristal a trois personnes, ou de le jeter au sol apres
 *    l'avoir mis en vitrine.
 *
 * 2. **L'or est au compte.** Le vendeur est paye sur son compte, pas dans son
 *    sac. Il peut donc etre deconnecte, ou en train de jouer une autre classe :
 *    il retrouvera son or a la prochaine connexion, quelle qu'elle soit.
 *
 * Comme pour le sol et les echanges, les artefacts de classe ne sont jamais
 * vendables : ils appartiennent au personnage, pas au marche.
 */
class Market {
  constructor(accounts) {
    this.accounts = accounts;
    this.store = new Store(path.join(DATA_DIR, 'market.json'), { listings: {}, seq: 0 }).autoFlush(2000);
    if (!this.store.data.listings) this.store.data.listings = {};
    if (typeof this.store.data.seq !== 'number') this.store.data.seq = 0;
    this.sanitize();
  }

  get listings() {
    return this.store.data.listings;
  }

  /**
   * Nettoyage au demarrage : une annonce dont le type a disparu du catalogue,
   * dont le compte vendeur n'existe plus ou dont les nombres sont absurdes est
   * ecartee. Les objets sequestres dedans sont perdus — c'est le prix a payer
   * pour ne jamais servir une annonce inachetable.
   */
  sanitize() {
    let dropped = 0;
    for (const [id, l] of Object.entries(this.listings)) {
      const ok = l && isDroppable(l.type)
        && Number.isFinite(l.qty) && l.qty >= 1
        && Number.isFinite(l.price) && l.price >= 1 && l.price <= CONFIG.MARKET.maxPrice
        && this.accounts.users[l.sellerId];
      if (ok) {
        l.qty = Math.floor(l.qty);
        l.price = Math.floor(l.price);
        continue;
      }
      delete this.listings[id];
      dropped++;
    }
    if (dropped) {
      console.log(`[market] ${dropped} annonce(s) ecartee(s) au demarrage`);
      this.store.touch();
    }
  }

  // --- Lecture ------------------------------------------------------------
  /** Une annonce telle que le client la voit, nom d'objet resolu. */
  view(l) {
    const def = ITEMS[l.type] || {};
    return {
      id: l.id,
      type: l.type,
      name: def.name || l.type,
      qty: l.qty,
      price: l.price,
      total: l.price * l.qty,
      sellerName: l.sellerName,
      sellerId: l.sellerId,
      at: l.at
    };
  }

  /** Toutes les annonces, la plus recente en tete. */
  browse() {
    return Object.values(this.listings)
      .sort((a, b) => b.at - a.at)
      .map(l => this.view(l));
  }

  countFor(accountId) {
    return Object.values(this.listings).filter(l => l.sellerId === accountId).length;
  }

  /** Etat complet envoye au client a l'ouverture de la fenetre et apres chaque action. */
  snapshot(accountId) {
    return {
      listings: this.browse(),
      gold: this.accounts.gold(accountId),
      slots: CONFIG.MARKET.maxPerAccount,
      used: this.countFor(accountId),
      coinValue: CONFIG.MARKET.coinValue,
      maxPrice: CONFIG.MARKET.maxPrice
    };
  }

  // --- Mise en vente ------------------------------------------------------
  list(player, payload = {}) {
    const type = String(payload.type || '');
    if (!isDroppable(type)) return { error: 'Cet objet ne peut pas être mis en vente.' };

    const def = ITEMS[type];
    const cap = def.stackable ? CONFIG.INVENTORY.maxStack : 1;
    const qty = Math.max(1, Math.min(cap, Math.floor(Number(payload.qty) || 1)));
    const price = Math.floor(Number(payload.price) || 0);

    if (!Number.isFinite(price) || price < 1 || price > CONFIG.MARKET.maxPrice) {
      return { error: `Le prix unitaire doit être compris entre 1 et ${CONFIG.MARKET.maxPrice} or.` };
    }
    if (this.countFor(player.accountId) >= CONFIG.MARKET.maxPerAccount) {
      return { error: `Tu ne peux pas avoir plus de ${CONFIG.MARKET.maxPerAccount} annonces à la fois.` };
    }
    if (player.inventory.count(type) < qty) {
      return { error: `Tu n'as pas ${qty} ${def.name} dans ton sac.` };
    }

    // Sequestre : les objets quittent le sac tout de suite.
    for (let i = 0; i < qty; i++) player.inventory.removeType(type);

    const id = `v${++this.store.data.seq}`;
    const listing = {
      id,
      sellerId: player.accountId,
      sellerName: player.name,
      type,
      qty,
      price,
      at: Date.now()
    };
    this.listings[id] = listing;
    this.store.touch();

    return { listing: this.view(listing) };
  }

  // --- Retrait ------------------------------------------------------------
  cancel(player, id) {
    const listing = this.listings[String(id || '')];
    if (!listing) return { error: "Cette annonce n'existe plus." };
    if (listing.sellerId !== player.accountId) return { error: "Cette annonce n'est pas la tienne." };

    // Simulation a blanc : on ne supprime l'annonce que si le sac peut tout
    // reprendre, sinon les objets sequestres seraient purement perdus.
    const sim = new Inventory(player.inventory.toJSON());
    if (sim.add(listing.type, listing.qty) < listing.qty) {
      return { error: 'Ton sac est trop plein pour reprendre cette annonce.' };
    }

    player.inventory.add(listing.type, listing.qty);
    delete this.listings[listing.id];
    this.store.touch();

    return { listing: this.view(listing) };
  }

  // --- Achat --------------------------------------------------------------
  buy(player, payload = {}) {
    const listing = this.listings[String(payload.id || '')];
    if (!listing) return { error: "Cette annonce n'existe plus." };
    if (listing.sellerId === player.accountId) {
      return { error: 'C\'est ta propre annonce — retire-la pour récupérer l\'objet.' };
    }

    const qty = Math.max(1, Math.min(listing.qty, Math.floor(Number(payload.qty) || 1)));
    const total = listing.price * qty;

    const purse = this.accounts.gold(player.accountId);
    if (purse < total) return { error: `Il te manque ${total - purse} or.` };

    const sim = new Inventory(player.inventory.toJSON());
    if (sim.add(listing.type, qty) < qty) return { error: 'Ton sac est trop plein pour cet achat.' };

    // Debit d'abord : si le compte a change entre-temps, rien n'a bouge.
    if (!this.accounts.spendGold(player.accountId, total)) {
      return { error: 'Ta bourse a changé entre-temps, réessaie.' };
    }
    this.accounts.addGold(listing.sellerId, total);
    player.inventory.add(listing.type, qty);

    listing.qty -= qty;
    const soldOut = listing.qty <= 0;
    if (soldOut) delete this.listings[listing.id];
    this.store.touch();

    return {
      type: listing.type,
      name: ITEMS[listing.type].name,
      qty,
      total,
      unit: listing.price,
      soldOut,
      sellerId: listing.sellerId,
      sellerName: listing.sellerName,
      gold: this.accounts.gold(player.accountId)
    };
  }

  // --- Bourse -------------------------------------------------------------
  /** Verse toutes les pieces d'or du sac dans la bourse du compte. */
  cashCoins(player) {
    const coins = player.inventory.count('piece_or');
    if (coins <= 0) return { error: "Tu n'as aucune pièce d'or dans ton sac." };

    for (let i = 0; i < coins; i++) player.inventory.removeType('piece_or');
    const amount = coins * CONFIG.MARKET.coinValue;
    return { coins, amount, gold: this.accounts.addGold(player.accountId, amount) };
  }

  flush() {
    this.store.flush();
  }
}

module.exports = Market;
