// Configuration partagee : le serveur l'envoie au client a la connexion,
// pour eviter d'avoir deux sources de verite qui divergent.
const MapData = require('./map');
const MapData2 = require('./map2');

const CONFIG = {
  TICK_HZ: 30,          // pas de simulation serveur
  SNAPSHOT_HZ: 20,      // frequence d'envoi de l'etat aux clients

  // Le monde est mesure sur la salle de spawn : les joueurs y arrivent
  // toujours en premier, c'est elle qui sert de reference pour le repli
  // hors-ligne du client (voir applyInput sans collision dans main.js).
  WORLD: {
    width: MapData.WIDTH,
    height: MapData.HEIGHT,
    tile: MapData.CELL
  },

  // Salles du donjon : image de fond, grille de collision, lumieres, depots.
  // Tout se regle dans server/map.js (spawn) et server/map2.js (crypte).
  MAPS: {
    room1: MapData.clientData(),
    room2: MapData2.clientData()
  },

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

  CHAT: {
    maxLength: 256,     // longueur max d'un message
    historySize: 80,    // messages gardes par salle (et pour les canaux serveur)
    burst: 5,           // messages autorises coup sur coup
    refillMs: 1200,     // un jeton de parole regagne toutes les 1,2 s
    muteMs: 5000,       // silence impose apres un flood
    bubbleMs: 6500      // duree de la bulle au-dessus du personnage
  },

  // Hotel de vente : chacun depose ses objets au prix qu'il veut, les autres
  // achetent a ce prix. La monnaie est la bourse du compte (voir MARKET.coinValue).
  MARKET: {
    startingGold: 250,    // bourse offerte a la creation du compte
    maxPerAccount: 8,     // annonces simultanees par compte
    maxPrice: 99999,      // prix unitaire maximum
    coinValue: 20         // ce que rapporte une piece d'or deposee en bourse
  },

  TRADE: {
    requestRange: 160,      // distance max (px) pour proposer un echange a un autre joueur
    requestTimeoutMs: 20000,// delai avant expiration d'une demande sans reponse
    maxOfferTypes: 6        // nombre de types d'objets differents offrables a la fois
  }
};

module.exports = CONFIG;
