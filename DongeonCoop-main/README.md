# DongeonCoop — multijoueur temps réel avec comptes

Terrain plat partagé : chaque joueur se connecte à son compte, est déposé là où il s'était arrêté, ramasse du butin et retrouve sa position, son inventaire et ses statistiques à la connexion suivante.

## Lancer

```bash
npm install
npm start          # http://localhost:3000
npm test           # tests de fumée (serveur déjà lancé)
```

## Architecture

```
server.js               Express + Socket.IO, API comptes, boucles de simulation, autosave
server/config.js        Constantes partagées (envoyées au client à la connexion)
server/accounts.js      Comptes : inscription, connexion, jetons, profils persistés
server/store.js         Stockage JSON sur disque (écriture atomique et différée)
server/inventory.js     Inventaire autoritatif : cases, empilage, ajout/retrait
server/items.js         Catalogue d'objets et tirage pondéré du butin
server/Room.js          Salle : joueurs, butin au sol, simulation, snapshots
server/RoomManager.js   Répartition des joueurs, création de salles au-delà de 16
public/js/auth.js       Inscription/connexion, jeton en localStorage, reprise de session
public/js/net.js        Socket, buffer de snapshots, horloge serveur, latence
public/js/input.js      Clavier ZQSD/WASD/flèches + joystick tactile
public/js/render.js     Rendu canvas : sol, plots de dépôt, butin, joueurs
public/js/main.js       Boucle client : prédiction, réconciliation, interpolation, inventaire
```

## Comptes et sauvegarde

**Inscription / connexion** — pseudo (3 à 14 caractères) + mot de passe (6 minimum), haché en bcrypt. Le serveur renvoie un jeton de session signé en HMAC, valable 30 jours, conservé en `localStorage` : au retour sur la page, le joueur entre directement en jeu.

**Ce qui est sauvegardé sur le compte**

| Donnée | Détail |
|---|---|
| Position | `x`, `y`, orientation — le joueur réapparaît exactement où il s'était arrêté |
| Inventaire | 12 cases, piles jusqu'à 20, types validés au rechargement |
| Statistiques | temps de jeu, objets ramassés, distance parcourue, nombre de sessions |
| Identité | pseudo, couleur, date de création, dernière connexion |

**Quand ça sauvegarde** — à la déconnexion, toutes les 30 s en autosave, à la fermeture de l'onglet (`beforeunload`), et sur demande du client. L'écriture disque est atomique (fichier temporaire puis `rename`) : une coupure en pleine écriture ne corrompt pas le fichier.

**Un seul jeu par compte** — une seconde connexion sur le même compte sauvegarde puis éjecte la première session, ce qui évite les duplications d'objets.

### ⚠️ Persistance sur Render

Le disque d'une instance Render est **éphémère** : `data/accounts.json` est effacé à chaque redéploiement. Deux options :

1. **Disque persistant Render** — monter un disque, puis pointer le stockage dessus : `DATA_DIR=/var/data`.
2. **Vraie base de données** — réécrire `load` / `flush` / `data` dans `server/store.js` (Postgres, Redis…). Le reste du serveur ne connaît que cette interface.

Définir aussi `SESSION_SECRET` en production, sinon un secret est généré et stocké dans le fichier de données (les sessions sautent si ce fichier disparaît).

## Butin et inventaire

Des objets apparaissent sur le terrain (un toutes les 4 s, 16 maximum). On les ramasse en marchant dessus ; un clic sur une case de l'inventaire en jette un au sol, non reprenable pendant 800 ms. Le catalogue est dans `server/items.js` : ajouter une entrée suffit, le loot et le rendu client suivent.

## Modèle réseau

Le serveur est **autoritatif** : il possède positions et inventaires, le client ne fait que prédire.

1. Le client envoie 30 commandes/s : `{ seq, dt, ax, ay }`.
2. Il applique la commande localement tout de suite (prédiction → zéro latence ressentie) et la garde en file d'attente.
3. Le serveur simule à 30 Hz et diffuse un snapshot à 20 Hz avec le `seq` de la dernière commande traitée par joueur.
4. À réception, le client repart de la position serveur et rejoue les commandes non acquittées (réconciliation).
5. Les joueurs distants sont rendus avec 100 ms de retard et interpolés entre deux snapshots.

### Garde-fous serveur

- `dt` borné à 50 ms par commande, plus un budget de temps global (1,15× le temps réel écoulé) : impossible d'accélérer en spammant.
- Positions bornées au terrain, séparation douce des joueurs qui se chevauchent.
- Entrées ignorées pendant la chute (700 ms après le dépôt).
- Inventaire modifié uniquement par le serveur : le client demande, il ne décide pas.
- Inventaires rechargés du disque nettoyés (types inconnus et quantités hors bornes écartés).
- Mots de passe jamais stockés en clair, jetons signés et vérifiés en temps constant.

## API

| Route | Effet |
|---|---|
| `POST /api/register` | `{ username, password }` → `{ token, profile }` |
| `POST /api/login` | `{ username, password }` → `{ token, profile }` |
| `GET /api/me` | En-tête `Authorization: Bearer <token>` → `{ profile }` |
| `GET /stats` | Salles, joueurs en ligne, nombre de comptes |
| `GET /health` | Sonde de disponibilité |

## Réglages

Tout est dans `server/config.js` — le client reçoit ces valeurs à la connexion, donc une seule modif suffit :

| Réglage | Effet |
|---|---|
| `WORLD.width / height` | Taille du terrain plat |
| `PLAYER.speed` | Vitesse de déplacement (px/s) |
| `PLAYER.maxPerRoom` | Joueurs par salle avant ouverture d'une nouvelle |
| `SPAWN.ringRadius / slots` | Rayon et nombre de points de dépôt des nouveaux comptes |
| `SPAWN.dropMs` | Durée de la chute à l'arrivée |
| `INVENTORY.slots / maxStack` | Taille de l'inventaire et des piles |
| `LOOT.maxOnGround / spawnEveryMs` | Densité et cadence du butin |
| `SAVE.autosaveMs` | Fréquence de l'autosave |
| `NET.interpDelayMs` | Retard d'interpolation (↑ = plus fluide, ↓ = plus réactif) |

## Étape suivante

La base est prête pour le contenu donjon : ajouter les murs/salles dans `Room` (grille de collision côté serveur, dessinée dans `render.js`), puis les monstres comme entités simulées dans `Room.step()` et diffusées dans le même snapshot. Les objets du catalogue peuvent devenir des équipements en ajoutant un champ `slot` et un effet appliqué côté serveur.
