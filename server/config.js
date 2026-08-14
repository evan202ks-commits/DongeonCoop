// Configuration partagee : le serveur l'envoie au client a la connexion,
// pour eviter d'avoir deux sources de verite qui divergent.
const CONFIG = {
  TICK_HZ: 30,          // pas de simulation serveur
  SNAPSHOT_HZ: 20,      // frequence d'envoi de l'etat aux clients

  WORLD: {
    width: 1920,        // terrain plat, sans relief ni obstacle
    height: 1920,
    tile: 64
  },

  PLAYER: {
    radius: 18,
    speed: 260,         // px / seconde
    maxPerRoom: 16
  },

  SPAWN: {
    ringRadius: 280,    // les joueurs sont deposes en cercle autour du centre
    slots: 16,
    dropMs: 700         // duree de la chute avant de toucher le sol
  },

  NET: {
    maxDt: 0.05,        // dt max accepte par commande (anti speed-hack)
    interpDelayMs: 100  // retard d'interpolation pour les joueurs distants
  }
};

module.exports = CONFIG;
