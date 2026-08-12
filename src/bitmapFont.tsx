import ReactEcs, { UiEntity, type UiTransformProps } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'

// Bitmap-font rendering from a spritesheet exported by SnowB BMF (https://snowb.org) or any tool
// using the AngelCode BMFont text format (.fnt). Each character is drawn as its own UiEntity,
// cropping the glyph out of the spritesheet via PBUiBackground's `uvs` field - same technique this
// file's other sprite-sheet UVs use (see getUvsForBlock in ui.tsx), just per-glyph instead of
// per-grid-cell.

interface Glyph {
  x: number
  y: number
  width: number
  height: number
  xoffset: number
  yoffset: number
  xadvance: number
}

interface BitmapFont {
  lineHeight: number
  scaleW: number
  scaleH: number
  glyphs: Map<number, Glyph>
  kernings: Map<string, number>
}

// Parses the AngelCode BMFont text format (the .fnt SnowB BMF exports alongside its spritesheet
// .png). Only the fields this renderer needs are extracted (common/char/kerning lines).
function parseFnt(fnt: string): BitmapFont {
  const commonMatch = fnt.match(/common lineHeight=(-?\d+).*scaleW=(\d+) scaleH=(\d+)/)
  if (!commonMatch) throw new Error('parseFnt: missing "common" line')
  const [, lineHeight, scaleW, scaleH] = commonMatch

  const glyphs = new Map<number, Glyph>()
  const charRegex = /char id=(\d+)\s+x=(-?\d+)\s+y=(-?\d+)\s+width=(-?\d+)\s+height=(-?\d+)\s+xoffset=(-?\d+)\s+yoffset=(-?\d+)\s+xadvance=(-?\d+)/g
  for (const m of fnt.matchAll(charRegex)) {
    const [, id, x, y, width, height, xoffset, yoffset, xadvance] = m
    glyphs.set(Number(id), {
      x: Number(x), y: Number(y), width: Number(width), height: Number(height),
      xoffset: Number(xoffset), yoffset: Number(yoffset), xadvance: Number(xadvance)
    })
  }

  const kernings = new Map<string, number>()
  const kerningRegex = /kerning first=(\d+)\s+second=(\d+)\s+amount=(-?\d+)/g
  for (const m of fnt.matchAll(kerningRegex)) {
    const [, first, second, amount] = m
    kernings.set(`${first}:${second}`, Number(amount))
  }

  return { lineHeight: Number(lineHeight), scaleW: Number(scaleW), scaleH: Number(scaleH), glyphs, kernings }
}

// Raw contents of assets/images/germ_one.fnt (SnowB BMF export, AngelCode BMFont text format).
const GERM_ONE_FNT_SOURCE = `
info face="Germania One" size=110 bold=0 italic=0 charset="32-58,61,63-90,95,97-122,124" unicode=1 stretchH=100 smooth=1 aa=1 padding=1,1,1,1 spacing=1,1 outline=0
common lineHeight=92 base=92 scaleW=1024 scaleH=1024 pages=1 packed=0 alphaChnl=0 redChnl=4 greenChnl=4 blueChnl=4
page id=0 file="germ_one.png"
chars count=84
char id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=28 page=0 chnl=15
char id=33 x=574 y=590 width=26 height=86 xoffset=4 yoffset=20 xadvance=33 page=0 chnl=15
char id=34 x=0 y=826 width=45 height=31 xoffset=4 yoffset=20 xadvance=52 page=0 chnl=15
char id=35 x=246 y=826 width=61 height=82 xoffset=4 yoffset=24 xadvance=68 page=0 chnl=15
char id=36 x=328 y=826 width=46 height=82 xoffset=3 yoffset=22 xadvance=52 page=0 chnl=15
char id=37 x=656 y=590 width=75 height=82 xoffset=4 yoffset=24 xadvance=82 page=0 chnl=15
char id=38 x=410 y=826 width=75 height=86 xoffset=4 yoffset=20 xadvance=82 page=0 chnl=15
char id=39 x=82 y=826 width=25 height=31 xoffset=4 yoffset=20 xadvance=32 page=0 chnl=15
char id=40 x=82 y=708 width=36 height=116 xoffset=2 yoffset=16 xadvance=41 page=0 chnl=15
char id=41 x=164 y=708 width=35 height=116 xoffset=4 yoffset=16 xadvance=41 page=0 chnl=15
char id=42 x=0 y=708 width=48 height=47 xoffset=3 yoffset=16 xadvance=54 page=0 chnl=15
char id=43 x=328 y=708 width=48 height=45 xoffset=4 yoffset=46 xadvance=55 page=0 chnl=15
char id=44 x=656 y=708 width=26 height=34 xoffset=3 yoffset=83 xadvance=32 page=0 chnl=15
char id=45 x=410 y=708 width=36 height=15 xoffset=4 yoffset=61 xadvance=43 page=0 chnl=15
char id=46 x=574 y=708 width=25 height=23 xoffset=4 yoffset=83 xadvance=32 page=0 chnl=15
char id=47 x=738 y=708 width=61 height=116 xoffset=4 yoffset=16 xadvance=69 page=0 chnl=15
char id=48 x=656 y=472 width=48 height=82 xoffset=2 yoffset=24 xadvance=52 page=0 chnl=15
char id=49 x=738 y=472 width=50 height=80 xoffset=2 yoffset=24 xadvance=53 page=0 chnl=15
char id=50 x=820 y=472 width=49 height=80 xoffset=1 yoffset=24 xadvance=52 page=0 chnl=15
char id=51 x=0 y=590 width=49 height=82 xoffset=1 yoffset=24 xadvance=52 page=0 chnl=15
char id=52 x=82 y=590 width=51 height=80 xoffset=2 yoffset=24 xadvance=54 page=0 chnl=15
char id=53 x=164 y=590 width=49 height=80 xoffset=1 yoffset=26 xadvance=52 page=0 chnl=15
char id=54 x=246 y=590 width=48 height=82 xoffset=2 yoffset=24 xadvance=52 page=0 chnl=15
char id=55 x=328 y=590 width=48 height=80 xoffset=2 yoffset=26 xadvance=52 page=0 chnl=15
char id=56 x=410 y=590 width=48 height=82 xoffset=2 yoffset=24 xadvance=52 page=0 chnl=15
char id=57 x=492 y=590 width=48 height=82 xoffset=2 yoffset=24 xadvance=52 page=0 chnl=15
char id=58 x=738 y=590 width=26 height=57 xoffset=4 yoffset=49 xadvance=32 page=0 chnl=15
char id=61 x=492 y=708 width=48 height=41 xoffset=4 yoffset=48 xadvance=55 page=0 chnl=15
char id=63 x=820 y=590 width=50 height=86 xoffset=4 yoffset=20 xadvance=57 page=0 chnl=15
char id=64 x=164 y=826 width=64 height=86 xoffset=4 yoffset=20 xadvance=71 page=0 chnl=15
char id=65 x=0 y=0 width=52 height=84 xoffset=3 yoffset=20 xadvance=57 page=0 chnl=15
char id=66 x=82 y=0 width=58 height=84 xoffset=-1 yoffset=20 xadvance=59 page=0 chnl=15
char id=67 x=164 y=0 width=52 height=86 xoffset=0 yoffset=20 xadvance=53 page=0 chnl=15
char id=68 x=246 y=0 width=58 height=84 xoffset=-1 yoffset=20 xadvance=59 page=0 chnl=15
char id=69 x=328 y=0 width=47 height=84 xoffset=3 yoffset=20 xadvance=50 page=0 chnl=15
char id=70 x=410 y=0 width=51 height=84 xoffset=5 yoffset=20 xadvance=53 page=0 chnl=15
char id=71 x=492 y=0 width=52 height=86 xoffset=0 yoffset=20 xadvance=53 page=0 chnl=15
char id=72 x=574 y=0 width=58 height=84 xoffset=-1 yoffset=20 xadvance=59 page=0 chnl=15
char id=73 x=656 y=0 width=21 height=82 xoffset=4 yoffset=22 xadvance=28 page=0 chnl=15
char id=74 x=738 y=0 width=48 height=84 xoffset=-1 yoffset=22 xadvance=50 page=0 chnl=15
char id=75 x=820 y=0 width=58 height=84 xoffset=-1 yoffset=20 xadvance=59 page=0 chnl=15
char id=76 x=0 y=118 width=46 height=82 xoffset=-1 yoffset=22 xadvance=43 page=0 chnl=15
char id=77 x=82 y=118 width=80 height=84 xoffset=-1 yoffset=20 xadvance=81 page=0 chnl=15
char id=78 x=164 y=118 width=56 height=84 xoffset=-1 yoffset=20 xadvance=58 page=0 chnl=15
char id=79 x=246 y=118 width=52 height=86 xoffset=0 yoffset=20 xadvance=52 page=0 chnl=15
char id=80 x=328 y=118 width=58 height=84 xoffset=-1 yoffset=20 xadvance=57 page=0 chnl=15
char id=81 x=410 y=118 width=58 height=98 xoffset=0 yoffset=20 xadvance=52 page=0 chnl=15
char id=82 x=492 y=118 width=59 height=84 xoffset=-1 yoffset=20 xadvance=59 page=0 chnl=15
char id=83 x=574 y=118 width=52 height=86 xoffset=0 yoffset=20 xadvance=52 page=0 chnl=15
char id=84 x=656 y=118 width=50 height=82 xoffset=-1 yoffset=22 xadvance=47 page=0 chnl=15
char id=85 x=738 y=118 width=58 height=86 xoffset=-1 yoffset=20 xadvance=59 page=0 chnl=15
char id=86 x=820 y=118 width=52 height=86 xoffset=2 yoffset=20 xadvance=55 page=0 chnl=15
char id=87 x=0 y=236 width=79 height=86 xoffset=2 yoffset=20 xadvance=82 page=0 chnl=15
char id=88 x=82 y=236 width=59 height=84 xoffset=-2 yoffset=20 xadvance=56 page=0 chnl=15
char id=89 x=164 y=236 width=52 height=82 xoffset=1 yoffset=22 xadvance=54 page=0 chnl=15
char id=90 x=246 y=236 width=50 height=82 xoffset=0 yoffset=22 xadvance=50 page=0 chnl=15
char id=95 x=246 y=708 width=47 height=15 xoffset=4 yoffset=117 xadvance=54 page=0 chnl=15
char id=97 x=328 y=236 width=53 height=68 xoffset=1 yoffset=38 xadvance=52 page=0 chnl=15
char id=98 x=410 y=236 width=53 height=90 xoffset=-1 yoffset=16 xadvance=52 page=0 chnl=15
char id=99 x=492 y=236 width=45 height=68 xoffset=1 yoffset=38 xadvance=44 page=0 chnl=15
char id=100 x=574 y=236 width=47 height=90 xoffset=1 yoffset=16 xadvance=48 page=0 chnl=15
char id=101 x=656 y=236 width=47 height=68 xoffset=1 yoffset=38 xadvance=49 page=0 chnl=15
char id=102 x=738 y=236 width=47 height=88 xoffset=-1 yoffset=16 xadvance=39 page=0 chnl=15
char id=103 x=820 y=236 width=47 height=94 xoffset=1 yoffset=38 xadvance=49 page=0 chnl=15
char id=104 x=0 y=354 width=58 height=90 xoffset=-1 yoffset=16 xadvance=56 page=0 chnl=15
char id=105 x=82 y=354 width=28 height=89 xoffset=0 yoffset=17 xadvance=25 page=0 chnl=15
char id=106 x=164 y=354 width=44 height=115 xoffset=-17 yoffset=17 xadvance=30 page=0 chnl=15
char id=107 x=246 y=354 width=55 height=90 xoffset=-1 yoffset=16 xadvance=56 page=0 chnl=15
char id=108 x=328 y=354 width=26 height=90 xoffset=1 yoffset=16 xadvance=26 page=0 chnl=15
char id=109 x=410 y=354 width=80 height=68 xoffset=-1 yoffset=38 xadvance=78 page=0 chnl=15
char id=110 x=492 y=354 width=58 height=68 xoffset=-1 yoffset=38 xadvance=56 page=0 chnl=15
char id=111 x=574 y=354 width=47 height=68 xoffset=1 yoffset=38 xadvance=48 page=0 chnl=15
char id=112 x=656 y=354 width=53 height=94 xoffset=-1 yoffset=38 xadvance=53 page=0 chnl=15
char id=113 x=738 y=354 width=47 height=94 xoffset=1 yoffset=38 xadvance=49 page=0 chnl=15
char id=114 x=820 y=354 width=47 height=66 xoffset=-1 yoffset=38 xadvance=43 page=0 chnl=15
char id=115 x=0 y=472 width=46 height=68 xoffset=0 yoffset=38 xadvance=45 page=0 chnl=15
char id=116 x=82 y=472 width=39 height=88 xoffset=-1 yoffset=18 xadvance=38 page=0 chnl=15
char id=117 x=164 y=472 width=46 height=66 xoffset=2 yoffset=40 xadvance=51 page=0 chnl=15
char id=118 x=246 y=472 width=49 height=68 xoffset=1 yoffset=38 xadvance=50 page=0 chnl=15
char id=119 x=328 y=472 width=72 height=68 xoffset=1 yoffset=38 xadvance=74 page=0 chnl=15
char id=120 x=410 y=472 width=49 height=64 xoffset=1 yoffset=40 xadvance=51 page=0 chnl=15
char id=121 x=492 y=472 width=52 height=94 xoffset=-1 yoffset=38 xadvance=54 page=0 chnl=15
char id=122 x=574 y=472 width=48 height=64 xoffset=0 yoffset=40 xadvance=46 page=0 chnl=15
char id=124 x=820 y=708 width=15 height=116 xoffset=4 yoffset=16 xadvance=22 page=0 chnl=15
kernings count=9
kerning first=65 second=84 amount=-2
kerning first=70 second=97 amount=-3
kerning first=76 second=84 amount=-4
kerning first=76 second=86 amount=-2
kerning first=76 second=89 amount=-7
kerning first=84 second=65 amount=-2
kerning first=84 second=97 amount=-4
kerning first=84 second=101 amount=-4
kerning first=84 second=117 amount=-3
`

export const GERM_ONE_FONT: BitmapFont = parseFnt(GERM_ONE_FNT_SOURCE)
export const GERM_ONE_IMAGE = 'assets/images/germ_one.png'
// Same glyph layout as GERM_ONE_IMAGE, pre-tinted brown (#2c180b, matches SCREEN_TEXT_COLOR in
// ui.tsx). uiBackground.color (the runtime tint used for the header's white/blinking stat text)
// isn't honored on mobile - see BitmapText's `image` doc below - so any bitmap text that needs a
// fixed, non-white color must use a baked variant like this instead of tinting GERM_ONE_IMAGE.
export const GERM_ONE_IMAGE_BROWN = 'assets/images/germ_one_brown.png'

// uvs go bottom-left, top-left, top-right, bottom-right (clockwise), per PBUiBackground - same
// convention as getUvsForBlock in ui.tsx. The .fnt's x/y are pixel coords from the sheet's
// top-left, so v (bottom-up) is the inverse of y (top-down).
function getGlyphUvs(glyph: Glyph, font: BitmapFont): number[] {
  const u1 = glyph.x / font.scaleW
  const u2 = (glyph.x + glyph.width) / font.scaleW
  const vTop = 1 - glyph.y / font.scaleH
  const vBottom = 1 - (glyph.y + glyph.height) / font.scaleH
  return [u1, vBottom, u1, vTop, u2, vTop, u2, vBottom]
}

interface BitmapTextProps {
  text: string // '\n' starts a new line
  font: BitmapFont
  image: string // e.g. GERM_ONE_IMAGE (white) or GERM_ONE_IMAGE_BROWN (pre-tinted)
  fontSize: number // rendered glyph height in px; scale is fontSize / font.lineHeight
  // Runtime tint via uiBackground.color - confirmed NOT applied on mobile (glyphs stay whatever
  // color `image` was baked as, regardless of this prop). Fine for effects that only need to work
  // on desktop (or that only ever go white->white, like a same-color blink), but any fixed
  // non-white color needed on mobile must come from a pre-tinted `image` instead - see
  // GERM_ONE_IMAGE_BROWN.
  color?: Color4
  uiTransform?: UiTransformProps // merged onto the outer container (margin, borders, etc.)
  align?: 'left' | 'center' | 'right' // horizontal alignment of each line; only matters with >1 line
}

// One line's worth of glyph quads, each cropped out of `image` via the matching glyph's uvs.
// Kerning pairs (if present in the .fnt) are applied as a margin-left nudge on the affected char.
function BitmapTextLine({ line, font, image, scale, rowHeight, color }: { key?: string | number; line: string; font: BitmapFont; image: string; scale: number; rowHeight: number; color?: Color4 }) {
  const chars = Array.from(line)
  const spaceAdvance = font.glyphs.get(32)?.xadvance ?? 0

  return (
    <UiEntity uiTransform={{ flexDirection: 'row', height: rowHeight, flexShrink: 0 }}>
      {chars.map((char, i) => {
        const id = char.codePointAt(0) ?? 32
        const glyph = font.glyphs.get(id)
        const prevId = i > 0 ? chars[i - 1].codePointAt(0) : undefined
        const kerning = prevId !== undefined ? (font.kernings.get(`${prevId}:${id}`) ?? 0) : 0

        if (glyph === undefined || glyph.width === 0 || glyph.height === 0) {
          const boxWidth = (glyph?.xadvance ?? spaceAdvance) * scale
          return <UiEntity key={i} uiTransform={{ width: boxWidth, height: rowHeight, flexShrink: 0 }} />
        }

        return (
          <UiEntity
            key={i}
            uiTransform={{ width: glyph.xadvance * scale, height: rowHeight, flexShrink: 0, margin: { left: kerning * scale } }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { left: glyph.xoffset * scale, top: glyph.yoffset * scale },
                width: glyph.width * scale,
                height: glyph.height * scale
              }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: image },
                uvs: getGlyphUvs(glyph, font),
                color
              }}
            />
          </UiEntity>
        )
      })}
    </UiEntity>
  )
}

export function BitmapText({ text, font, image, fontSize, color, uiTransform, align = 'left' }: BitmapTextProps) {
  const scale = fontSize / font.lineHeight
  const rowHeight = font.lineHeight * scale
  const lines = text.split('\n')
  const alignItems = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'

  return (
    <UiEntity uiTransform={{ flexDirection: 'column', alignItems, ...uiTransform }}>
      {lines.map((line, i) => (
        <BitmapTextLine key={i} line={line} font={font} image={image} scale={scale} rowHeight={rowHeight} color={color} />
      ))}
    </UiEntity>
  )
}
