// Configuration partagee : le serveur l'envoie au client a la connexion,
// pour eviter d'avoir deux sources de verite qui divergent.
const MapData = require('./map');

const CONFIG = {
  TICK_HZ: 30,          // pas de simulation serveur
  SNAPSHOT_HZ: 20,      // frequence d'envoi de l'etat aux clients

  WORLD: {
    width: MapData.WIDTH,   // le monde fait exactement la taille de l'image de la salle
    height: MapData.HEIGHT, // 1 unite monde = 1 pixel de salle-donjon.png
    tile: MapData.CELL
  },

  // Salle de donjon : image de fond, grille de collision, lumieres, depots.
  // Tout se regle dans server/map.js.
  MAP: MapData.clientData(),

  PLAYER: {
    radius: 18,
    speed: 260,         // px / seconde
    maxPerRoom: 16
  },

  SPAWN: {
    points: MapData.SPAWNS.length, // depots repartis dans la salle (server/map.js)
    dropMs: 700                    // duree de la chute avant de toucher le sol
  },

  INVENTORY: {
    slots: 12,
    maxStack: 20,
    pickupRadius: 30,
    dropCooldownMs: 800 // delai avant de pouvoir reprendre un objet qu'on vient de jeter
  },

  LOOT: {
    maxOnGround: 16,
    spawnEveryMs: 4000
  },

  NET: {
    maxDt: 0.05,        // dt max accepte par commande (anti speed-hack)
    interpDelayMs: 100  // retard d'interpolation pour les joueurs distants
  },

  SAVE: {
    autosaveMs: 30000   // sauvegarde periodique des joueurs connectes
  },

  TRADE: {
    requestRange: 160,      // distance max (px) pour proposer un echange a un autre joueur
    requestTimeoutMs: 20000,// delai avant expiration d'une demande sans reponse
    maxOfferTypes: 6        // nombre de types d'objets differents offrables a la fois
  }
};

module.exports = CONFIG;
