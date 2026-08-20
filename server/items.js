// Catalogue d'objets. Ajouter une entree dans LOOT suffit : le butin, l'inventaire
// et le rendu client la prennent en compte automatiquement.
//
// Les artefacts de classes (server/classes.js) sont fusionnes ici pour que
// l'inventaire et le client les connaissent, mais ils ne tombent jamais au sol :
// ils sont attribues a la classe qui les possede.
const { ARTIFACTS } = require('./classes');

const LOOT = {
  piece_or:   { name: "Pièce d'or",     color: '#facc15', stackable: true,  weight: 34, icon: '/icons/piece_or.png' },
  champignon: { name: 'Champignon',     color: '#fb7185', stackable: true,  weight: 22, icon: '/icons/champignon.png' },
  potion:     { name: 'Potion de soin', color: '#f472b6', stackable: true,  weight: 16, icon: '/icons/potion.png' },
  torche:     { name: 'Torche',         color: '#fb923c', stackable: true,  weight: 12, icon: '/icons/torche.png' },
  cle_rouille:{ name: 'Clé rouillée',   color: '#a8a29e', stackable: false, weight: 9,  icon: '/icons/cle_rouille.png' },
  cristal:    { name: 'Cristal',        color: '#38bdf8', stackable: true,  weight: 7,  icon: '/icons/cristal.png' }
};

const ITEMS = { ...LOOT };
for (const [id, art] of Object.entries(ARTIFACTS)) {
  ITEMS[id] = {
    name: art.name,
    color: art.color,
    stackable: false,
    artifact: true,
    slot: art.slot,
    classId: art.classId,
    desc: art.desc
  };
}

const LOOT_TYPES = Object.keys(LOOT);
const TYPES = Object.keys(ITEMS);
const TOTAL_WEIGHT = LOOT_TYPES.reduce((sum, t) => sum + LOOT[t].weight, 0);

function isValidType(type) {
  return Object.prototype.hasOwnProperty.call(ITEMS, type);
}

/** Un artefact ne se jette pas au sol : il serait perdu pour sa classe. */
function isDroppable(type) {
  return isValidType(type) && !ITEMS[type].artifact;
}

/** Tirage pondere : les pieces d'or tombent souvent, les cristaux rarement. */
function randomType() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const type of LOOT_TYPES) {
    roll -= LOOT[type].weight;
    if (roll <= 0) return type;
  }
  return LOOT_TYPES[0];
}

module.exports = { ITEMS, LOOT, TYPES, LOOT_TYPES, isValidType, isDroppable, randomType };
