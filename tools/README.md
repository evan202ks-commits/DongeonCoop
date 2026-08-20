# Fabrication des assets de la salle

`prepare-flammes.py` produit les deux images utilisees par le jeu, a partir des
sources rangees dans `sources/` :

```bash
python3 tools/prepare-flammes.py     # depuis la racine du projet
```

| Sortie | Contenu |
|---|---|
| `public/map/salle-donjon.png` | la salle **sans ses flammes** — elles y etaient peintes, elles en ont ete effacees |
| `public/map/flamme.png` | les 8 images de la boucle, cote a cote, fond transparent |

**Pourquoi effacer les flammes de la carte.** Sinon on verrait la flamme animee
se superposer a une flamme fixe. Le script les detecte a leur teneur en bleu —
la pierre du brasero est aussi claire que le feu, seule la couleur les separe —
puis rebouche le trou : en prolongeant les bandes horizontales pour les quatre
autels (le rebord de la vasque et les corniches se reconstituent tout seuls), en
aplat grene pour les quatre petits feux, dont la flamme couvrait tout son support.

**Deplacer ou retoucher un feu** se fait dans `server/map.js` (`FLAMES`), pas
ici : `x, y` visent le creux de la vasque. Ce script ne sert qu'a regenerer les
images, et seulement si les sources changent.

**La deuxieme ligne de la planche (torches murales) n'est pas exploitee** : la
pierre du support y est eclairee par la flamme, donc violette elle aussi, et
aucun seuil ne les separe proprement. Les huit feux partagent l'animation du
brasero, mise a l'echelle de leur support — dans la salle, ce sont de toute
facon le meme dessin a des tailles differentes.
