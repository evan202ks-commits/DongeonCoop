# DongeonCoop — multijoueur temps réel avec comptes et classes

**Une salle de donjon partagée**, murs et mobilier compris. On se connecte à son compte, **on choisit sa classe à chaque connexion** (Mage, Barbare, Archer, Voleur), et on reprend ce personnage exactement où il s'était arrêté : sa position, son inventaire, ses artefacts équipés et ses statistiques lui appartiennent en propre.

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
server/map.js           La salle : géométrie, obstacles, grille de collision, points de dépôt
server/accounts.js      Comptes : inscription, connexion, jetons, profils persistés
server/store.js         Stockage JSON sur disque (écriture atomique et différée)
server/inventory.js     Inventaire autoritatif : cases, empilage, ajout/retrait
server/classes.js       Les 4 classes, leurs artefacts, calcul des stats effectives
server/items.js         Catalogue d'objets (butin + artefacts) et tirage pondéré
server/Room.js          Instance de salle : joueurs, butin au sol, simulation, snapshots
server/RoomManager.js   Répartition des joueurs, création de salles au-delà de 16
public/js/auth.js       Inscription/connexion, jeton en localStorage, reprise de session
public/js/net.js        Socket, buffer de snapshots, horloge serveur, latence
public/js/input.js      Clavier ZQSD/WASD/flèches + joystick tactile
public/js/collision.js  Copie client du solveur de collisions (prédiction identique au serveur)
public/js/render.js     Rendu canvas : image de la salle, halos des brasiers, butin, joueurs
public/map/             salle-donjon.png (la carte) + fiche-assets.png (planche de référence)
public/js/main.js       Choix de classe, boucle client : prédiction, réconciliation, inventaire, équipement
```

## La salle

`public/map/salle-donjon.png` **est** la carte : le monde fait exactement la taille de l'image (1672 × 941), donc une coordonnée monde vaut un pixel de l'image. Le rendu est en `imageSmoothingEnabled = false` — du pixel art, pas du flou.

**Collisions.** `server/map.js` liste les obstacles en rectangles relevés sur l'image (enceinte, renfoncements latéraux murés, torches murales, les quatre autels, jarres, caisses, baril, rocher), puis les rasterise en une grille de cases de 16 px. Une case est solide si son centre tombe dans un obstacle. Le reste — os, mousses, grille d'égout, banderoles — est du décor peint au sol : on marche dessus.

Le déplacement se fait **axe par axe**, avec recherche dichotomique de la plus grande fraction libre : on glisse le long d'un mur au lieu de s'y coller à dix pixels, et un mouvement en diagonale contre une paroi continue le long de celle-ci.

**Une seule source de vérité.** La grille part au client dans `CONFIG.MAP` et `public/js/collision.js` rejoue exactement le même solveur : la prédiction locale heurte les mêmes murs que le serveur, sinon la réconciliation passerait son temps à corriger le joueur contre le mobilier. Les deux fichiers doivent rester synchronisés.

**Ajuster un obstacle.** Lire les coordonnées sur l'image, corriger le rectangle dans `SOLIDS`, relancer. **F2 en jeu** superpose la grille telle que le serveur la voit — c'est le moyen le plus rapide de vérifier qu'un autel ou une jarre est bien calé.

**Points de dépôt.** Seize positions réparties sur la croix centrale et dans les quatre quartiers, recalées automatiquement sur une case libre au chargement : une valeur approximative dans `SPAWNS` suffit. Une position sauvegardée qui tomberait dans un mur (compte d'avant la salle, obstacle déplacé depuis) est repoussée sur la case libre la plus proche — personne ne se réveille enfermé dans la pierre.

**Vivant.** Les neuf sources lumineuses (quatre brasiers, appliques du porche, torches murales, sceau central) respirent par-dessus l'image fixe côté client. Rien de tout ça n'est simulé : c'est du rendu pur, gratuit pour le serveur.

## Classes et artefacts

À la création du compte **et à chaque connexion**, l'écran de choix de classe s'affiche avant l'entrée sur le terrain. Une session sans classe est refusée par le serveur.

| Classe | Vitesse | Portée | Chance | Artefacts (Arme / Relique / Talisman) |
|---|---|---|---|---|
| **Mage** | 235 | 30 | 15 % | Bâton d'Arkheon · Orbe de mana · Grimoire scellé |
| **Barbare** | 225 | 40 | 5 % | Hache sanglante · Ceinture de force · Totem de rage |
| **Archer** | 265 | 46 | 8 % | Arc long d'if · Carquois sans fond · Œil de faucon |
| **Voleur** | 300 | 28 | 12 % | Dagues jumelles · Cape d'ombre · Main leste |

*Vitesse* en px/s, *portée* = rayon de ramassage en px, *chance* = probabilité d'obtenir un exemplaire supplémentaire à chaque ramassage.

**Un personnage par classe.** Chaque classe a son propre inventaire, son propre équipement, sa propre position et ses propres statistiques. Passer du Mage au Voleur, c'est changer de personnage, pas de tenue.

**Les artefacts sont attribués, pas lootés.** À la première partie jouée avec une classe, ses trois artefacts arrivent directement dans son sac. Ils ne tombent jamais au sol, ne se jettent pas, et ne s'équipent que par leur classe et dans leur emplacement — un clic sur l'artefact dans l'inventaire l'équipe, un clic sur l'emplacement le retire. Les effets (`speed` multiplicatif, `pickup` additif, `luck` additif) se cumulent et sont recalculés côté serveur à chaque changement, puis renvoyés au client pour que la prédiction reste exacte.

Ajouter une classe ou un artefact : une entrée dans `server/classes.js`, rien d'autre. Le catalogue est servi au client par `GET /api/classes`.

## Comptes et sauvegarde

**Inscription / connexion** — pseudo (3 à 14 caractères) + mot de passe (6 minimum), haché en bcrypt. Le serveur renvoie un jeton de session signé en HMAC, valable 30 jours, conservé en `localStorage` : au retour sur la page, le joueur saute la saisie du mot de passe — mais pas le choix de la classe.

**Ce qui est sauvegardé, par classe**

| Donnée | Détail |
|---|---|
| Position | `x`, `y`, orientation — le personnage réapparaît exactement où il s'était arrêté |
| Inventaire | 12 cases, piles jusqu'à 20, types validés au rechargement |
| Équipement | 3 emplacements (arme, relique, talisman), artefacts d'une autre classe écartés |
| Statistiques | temps de jeu, objets ramassés, distance parcourue, nombre de sessions |

Au niveau du compte : pseudo, couleur, date de création, dernière connexion, dernière classe jouée.

**Comptes d'avant les classes** — l'ancien état unique (position + inventaire + stats) est mis de côté et repris par le **premier personnage créé** ; les autres classes démarrent à neuf. Rien n'est dupliqué, rien n'est perdu.

**Quand ça sauvegarde** — à la déconnexion, toutes les 30 s en autosave, à la fermeture de l'onglet (`beforeunload`), et sur demande du client. L'écriture disque est atomique (fichier temporaire puis `rename`) : une coupure en pleine écriture ne corrompt pas le fichier.

**Un seul jeu par compte** — une seconde connexion sur le même compte sauvegarde puis éjecte la première session, ce qui évite les duplications d'objets.

### ⚠️ Persistance sur Render

Le disque d'une instance Render est **éphémère** : `data/accounts.json` est effacé à chaque redéploiement. Deux options :

1. **Disque persistant Render** — monter un disque, puis pointer le stockage dessus : `DATA_DIR=/var/data`.
2. **Vraie base de données** — réécrire `load` / `flush` / `data` dans `server/store.js` (Postgres, Redis…). Le reste du serveur ne connaît que cette interface.

Définir aussi `SESSION_SECRET` en production, sinon un secret est généré et stocké dans le fichier de données (les sessions sautent si ce fichier disparaît).

## Butin et inventaire

Des objets apparaissent sur la dalle (un toutes les 4 s, 16 maximum) — jamais dans un mur ni sous un autel, et un objet jeté devant soi retombe aux pieds du joueur si le passage est bouché. On les ramasse en marchant dessus — la portée dépend de la classe et des artefacts équipés ; un clic sur une case de l'inventaire en jette un au sol, non reprenable pendant 800 ms. Un clic sur un artefact l'équipe au lieu de le jeter. Le catalogue de butin est dans `server/items.js` (`LOOT`) : ajouter une entrée suffit, le loot et le rendu client suivent.

## Modèle réseau

Le serveur est **autoritatif** : il possède positions et inventaires, le client ne fait que prédire.

1. Le client envoie 30 commandes/s : `{ seq, dt, ax, ay }`.
2. Il applique la commande localement tout de suite (prédiction → zéro latence ressentie) et la garde en file d'attente.
3. Le serveur simule à 30 Hz et diffuse un snapshot à 20 Hz avec le `seq` de la dernière commande traitée par joueur.
4. À réception, le client repart de la position serveur et rejoue les commandes non acquittées (réconciliation).
5. Les joueurs distants sont rendus avec 100 ms de retard et interpolés entre deux snapshots.

### Garde-fous serveur

- `dt` borné à 50 ms par commande, plus un budget de temps global (1,15× le temps réel écoulé) : impossible d'accélérer en spammant.
- Positions bornées à la salle et testées contre la grille de collision, séparation douce des joueurs qui se chevauchent.
- Entrées ignorées pendant la chute (700 ms après le dépôt).
- Inventaire et équipement modifiés uniquement par le serveur : le client demande, il ne décide pas.
- Classe validée à l'entrée en jeu ; un artefact refusé si ce n'est pas celui de la classe ou pas le bon emplacement.
- Vitesse issue de la classe et des artefacts équipés côté serveur : un client qui gonfle sa vitesse est corrigé par la réconciliation.
- Inventaires rechargés du disque nettoyés (types inconnus et quantités hors bornes écartés).
- Mots de passe jamais stockés en clair, jetons signés et vérifiés en temps constant.

## API

| Route | Effet |
|---|---|
| `POST /api/register` | `{ username, password }` → `{ token, profile }` |
| `GET /api/classes` | Catalogue des classes, artefacts et emplacements d'équipement |
| `POST /api/login` | `{ username, password }` → `{ token, profile }` |
| `GET /api/me` | En-tête `Authorization: Bearer <token>` → `{ profile }` |
| `GET /stats` | Salles, joueurs en ligne, nombre de comptes |
| `GET /health` | Sonde de disponibilité |

## Réglages

Tout est dans `server/config.js` — le client reçoit ces valeurs à la connexion, donc une seule modif suffit :

| Réglage | Effet |
|---|---|
| `WORLD.width / height` | Taille de la salle — dérivée de l'image, à ne pas modifier à la main |
| `PLAYER.speed` | Vitesse de repli (les classes définissent la leur dans `classes.js`) |
| `PLAYER.maxPerRoom` | Joueurs par salle avant ouverture d'une nouvelle |
| `SPAWN.points` | Nombre de points de dépôt (la liste elle-même est dans `server/map.js`) |
| `SPAWN.dropMs` | Durée de la chute à l'arrivée |
| `INVENTORY.slots / maxStack` | Taille de l'inventaire et des piles (par classe) |
| `LOOT.maxOnGround / spawnEveryMs` | Densité et cadence du butin |
| `SAVE.autosaveMs` | Fréquence de l'autosave |
| `NET.interpDelayMs` | Retard d'interpolation (↑ = plus fluide, ↓ = plus réactif) |

## Étape suivante

Les murs sont là. Le prochain morceau, ce sont **les monstres** : des entités simulées dans `Room.step()` et diffusées dans le même snapshot que les joueurs — la grille de collision de `server/map.js` leur sert telle quelle, et `nearestFree` donne déjà des points d'apparition valides.

Ensuite, **plusieurs salles** : `server/map.js` expose une salle unique, mais rien dans `Room` ne suppose qu'il n'y en a qu'une. Une carte par fichier, un identifiant de carte sur le joueur, et les renfoncements latéraux murés deviennent de vraies portes.

Côté classes, tout est déjà branché pour aller plus loin : des sorts par classe (un `cooldown` par artefact équipé et un événement diffusé dans le snapshot), des artefacts rares qui se lootent au sol (retirer le filtre `artifact` de `randomType`), ou des niveaux par personnage (les stats sont déjà stockées par classe).
