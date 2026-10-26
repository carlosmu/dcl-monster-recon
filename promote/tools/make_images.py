# Builds the kit's social images from the game's own 2D art (no Blender renders: the monsters are sprites).
#   python promote/tools/make_images.py
# Writes promote/images/social/: codex_locked_1080.png, monster_<slug>_1080.png, quote_<id>_1080.png
import os, json
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = os.path.join(ROOT, 'promote')
OUT = os.path.join(P, 'images', 'social')
os.makedirs(OUT, exist_ok=True)
brand = json.load(open(os.path.join(P, 'posts.json'), encoding='utf-8'))['brand']

SHEET = Image.open(os.path.join(ROOT, 'assets/images/prizes_01.png')).convert('RGBA')
LOCKED = Image.open(os.path.join(ROOT, 'assets/images/prizes_01_not_collected.png')).convert('RGBA')
COLS, ROWS = 5, 4
CW, CH = SHEET.width / COLS, SHEET.height / ROWS
# Same order and rarity split as MONSTER_NAMES / COLLECTIONS in src/ui.tsx
RARITY = ['Common'] * 8 + ['Rare'] * 6 + ['Exotic'] * 4 + ['Epic'] * 2
RARITY_COLOR = {'Common': '#E8E2D0', 'Rare': '#5FB8FF', 'Exotic': '#C77DFF', 'Epic': '#FF8A1F'}
S = 1080


def font(size, small=False):
    return ImageFont.truetype(brand['font_small' if small else 'font'], size)


def background():
    top, bottom = (59, 26, 107), (22, 11, 43)
    im = Image.new('RGBA', (S, S))
    d = ImageDraw.Draw(im)
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    return im


def cell(sheet, i):
    c, r = i % COLS, i // COLS
    return sheet.crop((round(c * CW), round(r * CH), round((c + 1) * CW), round((r + 1) * CH)))


def text_center(d, y, line, f, fill):
    w = d.textlength(line, font=f)
    d.text(((S - w) / 2, y), line, font=f, fill=fill, stroke_width=max(2, f.size // 14), stroke_fill=brand['ink'])


def paste_monster(im, i, height, cy):
    m = cell(SHEET, i)
    scale = height / m.height
    m = m.resize((round(m.width * scale), round(m.height * scale)), Image.LANCZOS)
    im.alpha_composite(m, ((S - m.width) // 2, round(cy - m.height / 2)))


def codex_locked():
    im = background()
    sheet = SHEET.copy()
    for i in (18, 19):   # the two Epics stay secret
        box = (round((i % COLS) * CW), round((i // COLS) * CH))
        sheet.paste(cell(LOCKED, i), box)
    sheet = sheet.resize((900, 900), Image.LANCZOS)
    im.alpha_composite(sheet, ((S - 900) // 2, 150))
    text_center(ImageDraw.Draw(im), 40, 'MONSTER CODEX', font(84), brand['text'])
    im.convert('RGB').save(os.path.join(OUT, 'codex_locked_1080.png'))


def portrait(slug, i, name):
    im = background()
    paste_monster(im, i, 720, 450)
    d = ImageDraw.Draw(im)
    text_center(d, 840, name.upper(), font(92), brand['text'])
    text_center(d, 960, RARITY[i].upper(), font(54, small=True), RARITY_COLOR[RARITY[i]])
    im.convert('RGB').save(os.path.join(OUT, 'monster_%s_1080.png' % slug))


def quote(qid, i, lines):
    im = background()
    paste_monster(im, i, 600, 640)
    d = ImageDraw.Draw(im)
    f = font(96)
    for n, line in enumerate(lines):
        text_center(d, 70 + n * 115, line, f, brand['accent'] if n == len(lines) - 1 else brand['text'])
    text_center(d, 990, 'MONSTER RECON', font(40, small=True), brand['text'])
    im.convert('RGB').save(os.path.join(OUT, 'quote_%s_1080.png' % qid))


codex_locked()
portrait('tomato', 0, 'Rogue Tomato')
portrait('corn', 10, 'Infernal Corn')
portrait('leek', 12, 'Tentacle Leek')
portrait('artichoke', 17, 'Cyclops Artichoke')
quote('chances', 1, ['COLLECT THE MONSTER.', 'CHANCES: 5/5'])
quote('timesup', 7, ["TIME'S UP"])
quote('collected', 2, ['MONSTER COLLECTED!'])
print('wrote', len(os.listdir(OUT)), 'images to', OUT)
