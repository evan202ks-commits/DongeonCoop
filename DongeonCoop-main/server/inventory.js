const CONFIG = require('./config');
const { ITEMS, isValidType } = require('./items');

/**
 * Inventaire autoritatif cote serveur : le client n'affiche que ce qu'on lui envoie.
 * Represente comme un tableau de `slots` cases, chaque case valant null ou { type, qty }.
 */
class Inventory {
  constructor(saved) {
    this.slots = Inventory.sanitize(saved);
  }

  /** Nettoie un inventaire venant du disque : types inconnus et quantites folles sont ecartes. */
  static sanitize(saved) {
    const size = CONFIG.INVENTORY.slots;
    const out = new Array(size).fill(null);
    if (!Array.isArray(saved)) return out;

    for (let i = 0; i < Math.min(saved.length, size); i++) {
      const slot = saved[i];
      if (!slot || !isValidType(slot.type)) continue;
      const qty = Math.max(1, Math.min(CONFIG.INVENTORY.maxStack, Math.floor(Number(slot.qty) || 1)));
      out[i] = { type: slot.type, qty: ITEMS[slot.type].stackable ? qty : 1 };
    }
    return out;
  }

  /**
   * Ajoute `qty` objets : d'abord dans les piles existantes, puis dans les cases vides.
   * Renvoie le nombre reellement ajoute (0 si l'inventaire est plein).
   */
  add(type, qty = 1) {
    if (!isValidType(type)) return 0;
    const max = ITEMS[type].stackable ? CONFIG.INVENTORY.maxStack : 1;
    let left = qty;

    if (ITEMS[type].stackable) {
      for (const slot of this.slots) {
        if (left <= 0) break;
        if (slot && slot.type === type && slot.qty < max) {
          const room = max - slot.qty;
          const take = Math.min(room, left);
          slot.qty += take;
          left -= take;
        }
      }
    }

    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (this.slots[i]) continue;
      const take = Math.min(max, left);
      this.slots[i] = { type, qty: take };
      left -= take;
    }

    return qty - left;
  }

  /** Retire 1 objet de la case donnee. Renvoie le type retire, ou null. */
  removeOne(index) {
    const slot = this.slots[index];
    if (!slot) return null;
    slot.qty -= 1;
    const type = slot.type;
    if (slot.qty <= 0) this.slots[index] = null;
    return type;
  }

  isFull() {
    return this.slots.every(Boolean);
  }

  count(type) {
    return this.slots.reduce((n, s) => n + (s && s.type === type ? s.qty : 0), 0);
  }

  toJSON() {
    return this.slots;
  }
}

module.exports = Inventory;
