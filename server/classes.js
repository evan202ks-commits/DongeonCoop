// Catalogue des classes et de leurs artefacts.
//
// Une classe = une base de stats + trois artefacts qui lui sont propres.
// Les artefacts sont des objets d'inventaire comme les autres (ils passent par
// server/items.js), mais ils portent `slot` et `classId` : seule la bonne classe
// peut les equiper, et ils ne se ramassent pas au sol (ils sont donnes a la
// premiere partie jouee avec la classe).

const EQUIP_SLOTS = ['arme', 'relique', 'talisman'];

const SLOT_LABELS = {
  arme: 'Arme',
  relique: 'Relique',
  talisman: 'Talisman'
};

/**
 * Effets d'un artefact, tous cumulatifs :
 *   speed  : multiplicateur de vitesse (1.08 = +8 %)
 *   pickup : bonus de rayon de ramassage, en pixels
 *   luck   : chance d'obtenir un exemplaire supplementaire au ramassage
 */
const CLASSES = {
  mage: {
    id: 'mage',
    name: 'Mage',
    color: '#a855f7',
    tagline: 'Lent mais chanceux : le butin vient a lui.',
    base: { speed: 235, pickup: 30, luck: 0.15 },
    artifacts: {
      baton_arkheon: {
        name: "Bâton d'Arkheon", slot: 'arme', color: '#c084fc',
        effect: { luck: 0.2 }, desc: '+20 % de butin double'
      },
      orbe_mana: {
        name: 'Orbe de mana', slot: 'relique', color: '#818cf8',
        effect: { speed: 1.1 }, desc: '+10 % de vitesse'
      },
      grimoire_scelle: {
        name: 'Grimoire scellé', slot: 'talisman', color: '#6366f1',
        effect: { pickup: 14, luck: 0.05 }, desc: '+14 de portée, +5 % de butin double'
      }
    }
  },

  barbare: {
    id: 'barbare',
    name: 'Barbare',
    color: '#ef4444',
    tagline: 'Encaisse tout, ramasse large, avance lourdement.',
    base: { speed: 225, pickup: 40, luck: 0.05 },
    artifacts: {
      hache_sanglante: {
        name: 'Hache sanglante', slot: 'arme', color: '#dc2626',
        effect: { pickup: 16 }, desc: '+16 de portée de ramassage'
      },
      ceinture_force: {
        name: 'Ceinture de force', slot: 'relique', color: '#b45309',
        effect: { luck: 0.18 }, desc: '+18 % de butin double'
      },
      totem_rage: {
        name: 'Totem de rage', slot: 'talisman', color: '#f97316',
        effect: { speed: 1.14 }, desc: '+14 % de vitesse'
      }
    }
  },

  archer: {
    id: 'archer',
    name: 'Archer',
    color: '#22c55e',
    tagline: 'Portée de ramassage la plus longue du terrain.',
    base: { speed: 265, pickup: 46, luck: 0.08 },
    artifacts: {
      arc_long_if: {
        name: "Arc long d'if", slot: 'arme', color: '#16a34a',
        effect: { pickup: 22 }, desc: '+22 de portée de ramassage'
      },
      carquois_sans_fond: {
        name: 'Carquois sans fond', slot: 'relique', color: '#65a30d',
        effect: { luck: 0.12 }, desc: '+12 % de butin double'
      },
      oeil_faucon: {
        name: 'Œil de faucon', slot: 'talisman', color: '#a3e635',
        effect: { pickup: 18, speed: 1.04 }, desc: '+18 de portée, +4 % de vitesse'
      }
    }
  },

  voleur: {
    id: 'voleur',
    name: 'Voleur',
    color: '#38bdf8',
    tagline: 'Le plus rapide : arrive sur le butin avant les autres.',
    base: { speed: 300, pickup: 28, luck: 0.12 },
    artifacts: {
      dagues_jumelles: {
        name: 'Dagues jumelles', slot: 'arme', color: '#0ea5e9',
        effect: { speed: 1.08 }, desc: '+8 % de vitesse'
      },
      cape_ombre: {
        name: "Cape d'ombre", slot: 'relique', color: '#0f766e',
        effect: { speed: 1.12 }, desc: '+12 % de vitesse'
      },
      main_leste: {
        name: 'Main leste', slot: 'talisman', color: '#2dd4bf',
        effect: { luck: 0.22 }, desc: '+22 % de butin double'
      }
    }
  }
};

const CLASS_IDS = Object.keys(CLASSES);

/** Tous les artefacts, aplatis, indexes par identifiant d'objet. */
const ARTIFACTS = {};
for (const cls of Object.values(CLASSES)) {
  for (const [id, art] of Object.entries(cls.artifacts)) {
    ARTIFACTS[id] = { ...art, id, classId: cls.id, artifact: true, stackable: false };
  }
}

function isValidClass(classId) {
  return Object.prototype.hasOwnProperty.call(CLASSES, classId);
}

function isArtifact(type) {
  return Object.prototype.hasOwnProperty.call(ARTIFACTS, type);
}

/** Artefacts appartenant a une classe, sous forme de liste. */
function artifactsOf(classId) {
  return Object.values(ARTIFACTS).filter(a => a.classId === classId);
}

/** Un artefact n'est equipable que par sa classe, et dans son propre emplacement. */
function canEquip(classId, type, slot) {
  const art = ARTIFACTS[type];
  if (!art) return false;
  if (art.classId !== classId) return false;
  return slot ? art.slot === slot : true;
}

/** Equipement vide : un emplacement par type, tous a null. */
function emptyEquipment() {
  const out = {};
  for (const slot of EQUIP_SLOTS) out[slot] = null;
  return out;
}

/** Nettoie un equipement venant du disque : seuls les artefacts de la classe passent. */
function sanitizeEquipment(classId, saved) {
  const out = emptyEquipment();
  if (!saved || typeof saved !== 'object') return out;

  for (const slot of EQUIP_SLOTS) {
    const type = saved[slot];
    if (typeof type === 'string' && canEquip(classId, type, slot)) out[slot] = type;
  }
  return out;
}

/**
 * Statistiques effectives d'un joueur : base de la classe + effets des artefacts equipes.
 * Le serveur s'en sert pour la simulation, le client pour la prediction.
 */
function resolveStats(classId, equipment) {
  const cls = CLASSES[classId] || CLASSES.mage;
  const stats = { speed: cls.base.speed, pickup: cls.base.pickup, luck: cls.base.luck };

  for (const slot of EQUIP_SLOTS) {
    const type = equipment && equipment[slot];
    const art = type && ARTIFACTS[type];
    if (!art || art.classId !== cls.id) continue;

    const e = art.effect || {};
    if (e.speed) stats.speed *= e.speed;
    if (e.pickup) stats.pickup += e.pickup;
    if (e.luck) stats.luck += e.luck;
  }

  stats.speed = Math.round(stats.speed);
  stats.pickup = Math.round(stats.pickup);
  stats.luck = Math.min(0.9, Math.round(stats.luck * 100) / 100);
  return stats;
}

/** Version envoyee au client pour l'ecran de selection (sans logique serveur). */
function publicCatalog() {
  const out = {};
  for (const cls of Object.values(CLASSES)) {
    out[cls.id] = {
      id: cls.id,
      name: cls.name,
      color: cls.color,
      tagline: cls.tagline,
      base: cls.base,
      artifacts: artifactsOf(cls.id).map(a => ({
        id: a.id, name: a.name, slot: a.slot, color: a.color, desc: a.desc
      }))
    };
  }
  return out;
}

module.exports = {
  CLASSES, CLASS_IDS, ARTIFACTS, EQUIP_SLOTS, SLOT_LABELS,
  isValidClass, isArtifact, artifactsOf, canEquip,
  emptyEquipment, sanitizeEquipment, resolveStats, publicCatalog
};
