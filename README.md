# DongeonCoop — multijoueur temps réel

Terrain plat partagé : chaque joueur qui se connecte est déposé sur un point de l'anneau de spawn, voit les autres joueurs en temps réel et se déplace sur le même terrain.

## Lancer

```bash
npm install
npm start          # http://localhost:3000
npm test           # test de fumée (serveur déjà lancé)
```

Déploiement Render inchangé : `npm start`, port lu depuis `process.env.PORT`, WebSocket géré par Socket.IO avec repli polling.

## Architecture

```
server.js              Express + Socket.IO, boucles de simulation et d'envoi d'état
server/config.js       Constantes partagées (envoyées au client à la connexion)
server/Room.js         Salle autoritative : joueurs, spawn, simulation, snapshots
server/RoomManager.js  Répartition des joueurs, création de salles au-delà de 16
public/js/net.js       Socket, buffer de snapshots, horloge serveur, latence
public/js/input.js     Clavier ZQSD/WASD/flèches + joystick tactile
public/js/render.js    Rendu canvas : sol, plots de dépôt, joueurs
public/js/main.js      Boucle client : prédiction, réconciliation, interpolation
public/snake.html      L'ancien mini-jeu Snake, conservé tel quel
```

### Modèle réseau

Le serveur est **autoritatif** : il possède les positions, le client ne fait que prédire.

1. Le client envoie 30 commandes/s : `{ seq, dt, ax, ay }`.
2. Il applique la commande localement tout de suite (prédiction → zéro latence ressentie) et la garde dans une file d'attente.
3. Le serveur simule à 30 Hz et diffuse un snapshot à 20 Hz avec le `seq` de la dernière commande traitée par joueur.
4. À réception, le client repart de la position serveur et rejoue les commandes non encore acquittées (réconciliation).
5. Les joueurs distants sont rendus avec 100 ms de retard et interpolés entre deux snapshots → mouvement fluide même avec des pertes de paquets.

### Garde-fous serveur

- `dt` borné à 50 ms par commande, plus un budget de temps global (1,15× le temps réel écoulé) : impossible d'accélérer en spammant des commandes.
- Positions bornées au terrain, séparation douce quand deux joueurs se chevauchent.
- Pendant la chute (700 ms après le dépôt), les entrées sont ignorées.
- Noms filtrés et limités à 14 caractères.

## Régler le jeu

Tout est dans `server/config.js` — le client reçoit ces valeurs à la connexion, donc une modif suffit :

| Réglage | Effet |
|---|---|
| `WORLD.width / height` | Taille du terrain plat |
| `PLAYER.speed` | Vitesse de déplacement (px/s) |
| `PLAYER.maxPerRoom` | Joueurs par salle avant ouverture d'une nouvelle |
| `SPAWN.ringRadius / slots` | Rayon et nombre de points de dépôt |
| `SPAWN.dropMs` | Durée de la chute à l'arrivée |
| `NET.interpDelayMs` | Retard d'interpolation (↑ = plus fluide, ↓ = plus réactif) |

## Étape suivante

La base est prête pour le contenu donjon : ajouter les murs/salles dans `Room` (grille de collision côté serveur, dessinée côté `render.js`), puis les monstres comme entités simulées dans `Room.step()` et diffusées dans le même snapshot.
