"""
Prepare les assets de flammes :
  1. repart de l'image d'origine de la salle (non quantifiee)
  2. efface les 8 flammes fixes par diffusion des pixels voisins
  3. extrait les 8 images de la flamme depuis la planche fournie
  4. exporte une spritesheet a fond transparent
"""
from PIL import Image
import numpy as np
from scipy import ndimage

ROOM_SRC = 'tools/sources/salle-donjon-source.png'
SHEET_SRC = 'tools/sources/planche-flammes.png'
OUT = 'public/map'

# --- 1. Effacer les flammes de la carte ---------------------------------
# Une boite par flamme fixe : x0, y0, x1, y1, seuil de bleu, dilatation.
# Le seuil separe la flamme de la pierre qui l'entoure — les niches du porche
# sont peintes sur un panneau deja violet, il y faut un seuil plus severe que
# sur les braseros, poses sur de la pierre grise.
FLAME_BOXES = [
    (596, 282, 646, 348, 26, 2, 'lignes'),    # autel haut gauche
    (1023, 281, 1073, 347, 26, 2, 'lignes'),  # autel haut droite
    (598, 528, 648, 594, 26, 2, 'lignes'),    # autel bas gauche
    (1022, 528, 1072, 594, 26, 2, 'lignes'),  # autel bas droite
    (628, 78, 680, 142, 33, 2, 'aplat'),   # niche du porche, gauche
    (993, 76, 1045, 140, 33, 2, 'aplat'),  # niche du porche, droite
    (258, 226, 298, 272, 30, 1, 'aplat'),  # torche murale gauche
    (1373, 225, 1413, 271, 30, 1, 'aplat'), # torche murale droite

    # Au-dessus des braseros, la langue de feu se prolongeait en volutes
    # a peine teintees, posees sur le sol beige. Elles demandent un seuil
    # bien plus bas, sans quoi il en reste un voile clair au-dessus de
    # l'autel — mais le sol n'a pas de bleu, la marge reste large.
    (594, 254, 650, 298, 12, 2, 'aplat'),
    (1021, 253, 1077, 297, 12, 2, 'aplat'),
    (596, 500, 652, 544, 12, 2, 'aplat'),
    (1020, 500, 1076, 544, 12, 2, 'aplat'),
]


def erase_flames(img):
    a = np.asarray(img).astype(float)
    mask = np.zeros(a.shape[:2], bool)
    rows_mask = np.zeros(a.shape[:2], bool)
    for x0, y0, x1, y1, threshold, grow, mode in FLAME_BOXES:
        sub = a[y0:y1, x0:x1]
        blue = sub[:, :, 2] - sub[:, :, 0]
        lum = sub.mean(2)
        m = (blue > threshold) & (lum > 78)
        m = ndimage.binary_closing(m, np.ones((3, 3)))
        m = ndimage.binary_dilation(m, np.ones((3, 3)), iterations=grow)
        mask[y0:y1, x0:x1] |= m
        if mode == 'lignes':
            rows_mask[y0:y1, x0:x1] |= m

    # Reconstruction ligne par ligne : chaque pixel efface reprend le pixel
    # connu le plus proche a sa gauche et a sa droite, melanges selon la
    # distance. Les braseros et les niches sont faits de bandes horizontales
    # (rebord de la vasque, corniches) : les prolonger horizontalement les
    # reconstitue proprement, la ou une diffusion en etoile bavait.
    out = a.copy()

    # Les petites flammes (torches murales, niches du porche) couvrent toute la
    # largeur de leur support : il n'y a rien a prolonger de part et d'autre.
    # On repeint leur emprise d'un aplat pris sur le support lui-meme, ce que
    # la flamme animee recouvrira de toute facon en grande partie.
    for x0, y0, x1, y1, threshold, grow, mode in FLAME_BOXES:
        if mode != 'aplat':
            continue
        sub_mask = mask[y0:y1, x0:x1]
        sub = a[y0:y1, x0:x1]
        known = sub[~sub_mask]
        if not known.size:
            continue
        flat = np.median(known, axis=0)

        # Un aplat parfaitement uniforme se voit comme une tache. On lui rend le
        # grain du support en recopiant la texture de la meme boite decalee d'une
        # demi-largeur : la ou le decalage tombe sur du connu, on reprend son
        # ecart a la moyenne ; ailleurs on reste sur l'aplat.
        shifted = np.roll(sub, sub.shape[1] // 2, axis=1)
        shifted_mask = np.roll(sub_mask, sub_mask.shape[1] // 2, axis=1)
        grain = np.where(shifted_mask[:, :, None], 0.0, shifted - np.median(known, axis=0))
        patch = np.clip(flat + grain * 0.7, 0, 255)
        out[y0:y1, x0:x1][sub_mask] = patch[sub_mask]

    h, w = rows_mask.shape
    for y in range(h):
        row = rows_mask[y]
        if not row.any():
            continue
        known = np.flatnonzero(~mask[y])
        if known.size == 0:
            continue
        for x in np.flatnonzero(row):
            left = known[known < x]
            right = known[known > x]
            if left.size and right.size:
                lx, rx = left[-1], right[0]
                t = (x - lx) / float(rx - lx)
                out[y, x] = a[y, lx] * (1 - t) + a[y, rx] * t
            else:
                out[y, x] = a[y, left[-1] if left.size else right[0]]

    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)), mask


# --- 2. Extraire les flammes de la planche ------------------------------
def flame_alpha(rgb, spread=None):
    """
    Alpha des pixels de flamme.
    Le violet lumineux signe la flamme : la pierre du brasero est desaturee
    (bleu et vert proches) et l'interieur de la niche est sombre. Le coeur
    presque blanc, lui, n'est pas violet — on le recupere en bouchant les trous
    du contour violet, puisqu'il est toujours enferme dedans.
    """
    g, b = rgb[:, :, 1], rgb[:, :, 2]
    lum = rgb.mean(2)
    purple = np.clip((b - g - 45) / 40.0, 0, 1) * np.clip((lum - 85) / 50.0, 0, 1)
    # Le contour violet est ouvert en bas (l'image est coupee au niveau de la
    # pierre) : on ferme la silhouette avec une ligne pleine avant de boucher
    # les trous, sinon le coeur blanc n'est jamais considere comme enferme.
    body = purple > 0.3
    closed = np.vstack([body, np.ones((1,) + body.shape[1:], bool)])
    core = ndimage.binary_fill_holes(closed)[:-1] & (lum > 150)
    alpha = np.maximum(purple, core.astype(float))

    # La pierre du brasero est claire elle aussi, et le seuil de luminosite ne
    # suffit pas a l'en distinguer. Mais elle ne bouge pas d'une image a
    # l'autre, alors que la flamme vacille : tout ce qui est clair ET immobile
    # sur les 8 images est de la pierre, pas du feu.
    if spread is not None:
        alpha[(spread < 32) & (lum > 140)] = 0
    return alpha


def fade_base(frames, rows=9):
    """
    Les images sont coupees au niveau du rebord du brasero : sans traitement,
    la flamme aurait un bas parfaitement plat. On degrade l'alpha des
    dernieres lignes pour qu'elle semble jaillir de la vasque.
    """
    out = []
    for f in frames:
        a = np.asarray(f).astype(float)
        h = a.shape[0]
        for i in range(rows):
            a[h - 1 - i, :, 3] *= (i + 1) / (rows + 1.0)
        out.append(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA'))
    return out


def extract(sheet, centers, y0, y1, half, use_spread=False):
    crops = [np.asarray(sheet.crop((cx - half, y0, cx + half, y1))).astype(float)
             for cx in centers]
    stack = np.stack(crops)
    spread = (stack.max(0) - stack.min(0)).max(2) if use_spread else None   # ecart entre les 8 images

    frames = []
    for crop in crops:
        alpha = flame_alpha(crop, spread)
        # On ne garde que les taches assez grosses : les eclats de pierre isoles
        # captes par le seuil disparaissent, les etincelles de la flamme restent.
        lab, n = ndimage.label(alpha > 0.25)
        if n:
            sizes = ndimage.sum(alpha > 0.25, lab, range(1, n + 1))
            keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 6])
            alpha = alpha * keep
        rgba = np.dstack([crop, alpha * 255]).astype(np.uint8)
        frames.append(Image.fromarray(rgba, 'RGBA'))
    return frames


def trim(frames):
    """Rogne toutes les images sur la meme boite : l'ancrage reste stable."""
    box = None
    for f in frames:
        b = f.getbbox()
        if not b:
            continue
        box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]),
                                     max(box[2], b[2]), max(box[3], b[3]))
    return [f.crop(box) for f in frames], box


def pack(frames, path):
    w, h = frames[0].size
    sheet = Image.new('RGBA', (w * len(frames), h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * w, 0))
    sheet.save(path)
    return w, h


if __name__ == '__main__':
    room = Image.open(ROOM_SRC).convert('RGB')
    cleaned, mask = erase_flames(room)
    cleaned.save('/tmp/room_clean.png')
    # Palette reduite : la salle passe de 1,7 Mo a quelques centaines de Ko
    # sans perte visible, maintenant que les degrades de flamme n'y sont plus.
    cleaned.quantize(colors=64, dither=Image.Dither.NONE).save(OUT + '/salle-donjon.png', optimize=True)
    print('pixels effaces :', int(mask.sum()))

    sheet = Image.open(SHEET_SRC).convert('RGB')
    brasero_x = [88, 256, 423, 590, 755, 922, 1088, 1253]

    # Coupees juste au-dessus de la pierre du brasero : au-dessus de cette
    # ligne, tout ce qui n'est pas le fond est de la flamme, l'extraction est nette.
    brasero = fade_base(extract(sheet, brasero_x, 112, 219, 34))

    brasero, bbox_b = trim(brasero)
    print('brasero', brasero[0].size, bbox_b)

    pack(brasero, OUT + '/flamme.png')
