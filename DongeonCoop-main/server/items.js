// Catalogue d'objets. Ajouter une entree ici suffit : le loot, l'inventaire
// et le rendu client la prennent en compte automatiquement.
const ITEMS = {
  piece_or:   { name: "Pièce d'or",     color: '#facc15', stackable: true,  weight: 34 },
  champignon: { name: 'Champignon',     color: '#fb7185', stackable: true,  weight: 22 },
  potion:     { name: 'Potion de soin', color: '#f472b6', stackable: true,  weight: 16 },
  torche:     { name: 'Torche',         color: '#fb923c', stackable: true,  weight: 12 },
  cle_rouille:{ name: 'Clé rouillée',   color: '#a8a29e', stackable: false, weight: 9 },
  cristal:    { name: 'Cristal',        color: '#38bdf8', stackable: true,  weight: 7 }
};

const TYPES = Object.keys(ITEMS);
const TOTAL_WEIGHT = TYPES.reduce((sum, t) => sum + ITEMS[t].weight, 0);

function isValidType(type) {
  return Object.prototype.hasOwnProperty.call(ITEMS, type);
}

/** Tirage pondere : les pieces d'or tombent souvent, les cristaux rarement. */
function randomType() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const type of TYPES) {
    roll -= ITEMS[type].weight;
    if (roll <= 0) return type;
  }
  return TYPES[0];
}

module.exports = { ITEMS, TYPES, isValidType, randomType };
