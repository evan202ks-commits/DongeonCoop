"""
Apercu hors ligne de l'ouverture de la porte.

Rejoue exactement la geometrie de `server/map.js` (DOOR) et la meme mecanique
que `public/js/render.js` : passage sombre au fond, rouage tourne autour de son
moyeu, deux moities de battant ecartees et bornees a l'arche. Sert a caler
l'arche et le rouage sans avoir a lancer le jeu.

    python3 tools/preview-porte.py        # ecrit /tmp/door_preview.png
"""
from PIL import Image, ImageDraw
import json, subprocess

SRC = 'tools/sources/salle-donjon-source.png'
OUT = '/tmp/door_preview.png'

# La geometrie est lue dans map.js : un seul endroit a corriger.
DOOR = json.loads(subprocess.check_output(
    ['node', '-e', "process.stdout.write(JSON.stringify(require('./server/map.js').DOOR))"]))
ARCH, WHEEL = DOOR['arch'], DOOR['wheel']
CX, CY, R, BOT = ARCH['x'], ARCH['y'], ARCH['r'], ARCH['bottom']
HX, HY, HR = WHEEL['x'], WHEEL['y'], WHEEL['r']

BOX = (CX - 112, CY - R - 26, CX + 112, BOT + 34)
SIZE = (BOX[2] - BOX[0], BOX[3] - BOX[1])
OX, OY = BOX[0], BOX[1]


def arch_mask():
    m = Image.new('L', SIZE, 0)
    d = ImageDraw.Draw(m)
    d.pieslice([CX - R - OX, CY - R - OY, CX + R - OX, CY + R - OY], 180, 360, fill=255)
    d.rectangle([CX - R - OX, CY - OY, CX + R - OX, BOT - OY], fill=255)
    return m


def half_mask(side):
    m = Image.new('L', SIZE, 0)
    d = ImageDraw.Draw(m)
    if side < 0:
        d.rectangle([CX - R - 2 - OX, 0, CX - OX, SIZE[1]], fill=255)
    else:
        d.rectangle([CX - OX, 0, CX + R + 2 - OX, SIZE[1]], fill=255)
    return m


def frame(room, dx, angle):
    out = room.crop(BOX).convert('RGBA')
    mask = arch_mask()

    # Passage sombre au fond de l'ouverture.
    passage = Image.new('RGBA', SIZE, (0, 0, 0, 0))
    pd = ImageDraw.Draw(passage)
    top, bottom = CY - R - OY, BOT - OY
    for y in range(SIZE[1]):
        k = max(0.0, min(1.0, (y - top) / max(1, bottom - top)))
        pd.line([(0, y), (SIZE[0], y)],
                fill=(int(8 + 21 * k), int(5 + 15 * k), int(16 + 25 * k), 255))
    out.paste(passage, (0, 0), mask)

    # Battant : la carte elle-meme, bornee a l'arche, rouage tourne autour de
    # son moyeu. Le rouage est pris DANS le battant, comme dans render.js :
    # sa rotation ne peut ramener aucun pixel d'en dehors de la porte.
    leaf = Image.new('RGBA', SIZE, (0, 0, 0, 0))
    leaf.paste(room.crop(BOX).convert('RGBA'), (0, 0), mask)
    if angle:
        disc = Image.new('L', SIZE, 0)
        ImageDraw.Draw(disc).ellipse([HX - HR - OX, HY - HR - OY, HX + HR - OX, HY + HR - OY], fill=255)
        wheel = Image.new('RGBA', SIZE, (0, 0, 0, 0))
        wheel.paste(leaf, (0, 0), disc)
        leaf.alpha_composite(wheel.rotate(-angle, resample=Image.NEAREST, center=(HX - OX, HY - OY)))

    # Les deux moities glissent, chacune bornee a l'arche.
    for side in (-1, 1):
        piece = Image.new('RGBA', SIZE, (0, 0, 0, 0))
        piece.paste(leaf, (0, 0), half_mask(side))
        piece = piece.transform(SIZE, Image.AFFINE, (1, 0, -side * dx, 0, 1, 0), resample=Image.NEAREST)
        clipped = Image.new('RGBA', SIZE, (0, 0, 0, 0))
        clipped.paste(piece, (0, 0), mask)
        out.alpha_composite(clipped)
    return out


LABELS = ['1. fermee', '2. deverrouillage', '3. rotation', '4. deplacement', '5. ouverture', '6. ouverte']
STEPS = [(0, 0), (0, 0), (0, WHEEL['turn'] / 2), (0, WHEEL['turn']),
         (DOOR['slide'] * 0.45, WHEEL['turn']), (DOOR['slide'], WHEEL['turn'])]

room = Image.open(SRC).convert('RGBA')
tiles = [frame(room, dx, a) for dx, a in STEPS]

scale = 2
sheet = Image.new('RGBA', (SIZE[0] * len(tiles) * scale, SIZE[1] * scale + 18), (18, 18, 24, 255))
for i, t in enumerate(tiles):
    sheet.alpha_composite(t.resize((SIZE[0] * scale, SIZE[1] * scale), Image.NEAREST), (i * SIZE[0] * scale, 18))
    ImageDraw.Draw(sheet).text((i * SIZE[0] * scale + 6, 4), LABELS[i], fill=(210, 200, 230))
sheet.save(OUT)
print(f'{OUT} — {sheet.size[0]}x{sheet.size[1]}')
