import {
  engine,
  Transform,
  TextShape,
  TextAlignMode,
  Font,
  MeshRenderer,
  Material,
  VisibilityComponent,
  type Entity
} from '@dcl/sdk/ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../assets/scene/entity-names'
import { getLeaderboardFaceUrl } from './leaderboardProfileCache'

// In-world copy of the leaderboard's rows only - no title, no frame. Everything hangs off the
// Leaderboard_parent entity placed in the Creator Hub, so moving/rotating/scaling the board there
// moves the whole panel (the plane's own face is +Z, so the anchor's rotation aims it).
const ANCHOR_NAME = EntityNames.Leaderboard_parent
const ROWS = 10

// Column geometry lifted from the desktop rows in ui.tsx so the 3D panel reads the same: fixed rank
// column, square profile pic, name filling the middle, score pinned right. These are raw px at
// ui.tsx's 1920x1080 virtual reference; PX_TO_M maps one whole row onto PANEL_WIDTH_M in a single
// step, so every column keeps its desktop proportion no matter how wide the board is made.
const ROW_WIDTH_PX = 604.8 // canvas_main (0.4 * 1920) minus 2x FRAME_PADDING_PX, times the list's 90%
const ROW_HEIGHT_PX = 50 // LEADERBOARD_AVATAR_SIZE_PX + the row's 4px top/bottom padding
const RANK_WIDTH_PX = 40 // LEADERBOARD_RANK_WIDTH_PX
const AVATAR_SIZE_PX = 42 // LEADERBOARD_AVATAR_SIZE_PX
// Breathing room on both sides of the profile pic. Wider than the desktop list's 6px right margin
// (and unlike it, there's now a gap on the rank side too): at in-world reading distance the columns
// need more separation than they do on a flat screen to stop reading as one run-on line.
const AVATAR_GAP_PX = 14
const FONT_SIZE_PX = 16 // LEADERBOARD_ROW_NAME/SCORE_FONT_SIZE_PX

const PANEL_WIDTH_M = 3.6
const PX_TO_M = PANEL_WIDTH_M / ROW_WIDTH_PX
// Extra vertical air on top of the desktop row height. The 2D list is read straight on at arm's
// length, where its 4px row padding is enough; in-world the rows are read from a distance and at an
// angle, and that tight spacing runs them together. Only the pitch between rows grows - the profile
// pics keep their own size, so this is air, not scale.
const ROW_SPACING_FACTOR = 1.35
const ROW_HEIGHT_M = ROW_HEIGHT_PX * PX_TO_M * ROW_SPACING_FACTOR

// The only value here that isn't a pure ratio: TextShape's fontSize isn't in metres and the
// protocol doesn't define its unit, so this converts the desktop px size into whatever TextShape
// counts in. ~20 units per metre matches the SDK's own examples (a fontSize 4 label reads about
// 0.2m tall); worth one visual pass in the Explorer to confirm, and the only knob to turn if the
// text comes out too big or too small - the column widths are already correct on their own.
const TEXT_UNITS_PER_M = 20
const FONT_SIZE = FONT_SIZE_PX * PX_TO_M * TEXT_UNITS_PER_M

// The desktop rows are dark brown on the frame's light background. There's no backing plate here,
// so they'd read against whatever scene geometry is behind the board - white with a black outline
// instead, which is the usual treatment for unbacked 3D text.
const TEXT_COLOR = Color4.White()
// Rank and score in yellow, so the two numeric columns read as a pair and the names stay neutral.
const NUMBER_COLOR = Color4.Yellow()
const OUTLINE_COLOR = Color4.Black()
const OUTLINE_WIDTH = 0.2

const FALLBACK_FACE_IMAGE = 'assets/images/fallback_profile_pic.png'

// The name column has no hard right edge to stop it - the score is anchored to the panel's right
// edge and grows leftward - so a long name would run straight into it. Cut rather than shrunk, so
// every row keeps the same font size.
const NAME_MAX_CHARS = 18
const NAME_ELLIPSIS = '...'

// Faces resolve asynchronously (leaderboardProfileCache fetches them from the lambdas), and unlike
// the 2D UI - which re-reads the cache every render frame - these materials are only written when
// something changes. This is how a row picks up its real face once the fetch lands.
const FACE_REFRESH_INTERVAL = 0.5

export interface Leaderboard3dEntry {
  playerName: string
  score: number
  address: string
}

interface Row3d {
  rank: Entity
  avatar: Entity
  name: Entity
  score: Entity
  address: string // '' while the row is empty
  appliedFaceUrl: string
}

let rows: Row3d[] | null = null
let sinceFaceRefresh = 0

// Left edge of the panel in the anchor's local space. Horizontally the board is centered on the
// anchor; vertically the anchor is its top - see createRow.
const LEFT = -PANEL_WIDTH_M / 2
const RANK_W = RANK_WIDTH_PX * PX_TO_M
const AVATAR_SIZE = AVATAR_SIZE_PX * PX_TO_M
const AVATAR_GAP = AVATAR_GAP_PX * PX_TO_M
const AVATAR_LEFT = LEFT + RANK_W + AVATAR_GAP
const NAME_LEFT = AVATAR_LEFT + AVATAR_SIZE + AVATAR_GAP

// Each text entity is placed at the exact edge its alignment pins to (right edge for the rank and
// the score, left edge for the name) with its box collapsed to nothing. The protocol calls width
// "available horizontal space" without saying whether the box is centered on the entity and the
// text aligns inside it, or whether the entity IS the alignment point - a wide box put the name
// half a box-width off under the second reading. At ~0 width the two readings coincide, so the
// column edges hold either way. textWrapping stays off, so the box has no other job.
const TEXT_BOX_WIDTH = 0.001

function createText(parent: Entity, x: number, y: number, textAlign: TextAlignMode, textColor: Color4): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, { position: Vector3.create(x, y, 0), parent })
  TextShape.create(entity, {
    text: '',
    font: Font.F_SANS_SERIF,
    fontSize: FONT_SIZE,
    textColor,
    outlineColor: OUTLINE_COLOR,
    outlineWidth: OUTLINE_WIDTH,
    textAlign,
    width: TEXT_BOX_WIDTH,
    height: ROW_HEIGHT_M,
    textWrapping: false
  })
  return entity
}

function createRow(parent: Entity, index: number): Row3d {
  // The anchor is the top edge: row 1 hangs directly below it and each row after that goes further
  // down, so wherever the anchor sits is exactly where "1." lands. Rows that run past whatever's
  // visible down there are the ones that get cut off, never the top of the table.
  const y = -(index + 0.5) * ROW_HEIGHT_M

  const avatar = engine.addEntity()
  Transform.create(avatar, {
    position: Vector3.create(AVATAR_LEFT + AVATAR_SIZE / 2, y, 0),
    scale: Vector3.create(AVATAR_SIZE, AVATAR_SIZE, 1),
    parent
  })
  MeshRenderer.setPlane(avatar)
  VisibilityComponent.create(avatar, { visible: false })

  return {
    rank: createText(parent, LEFT + RANK_W, y, TextAlignMode.TAM_MIDDLE_RIGHT, NUMBER_COLOR),
    avatar,
    name: createText(parent, NAME_LEFT, y, TextAlignMode.TAM_MIDDLE_LEFT, TEXT_COLOR),
    score: createText(parent, LEFT + PANEL_WIDTH_M, y, TextAlignMode.TAM_MIDDLE_RIGHT, NUMBER_COLOR),
    address: '',
    appliedFaceUrl: ''
  }
}

// Built on the first update rather than at setup: the anchor comes from the scene composite, so
// this stays correct even if the lookup isn't resolvable yet the first time around.
function ensureRows(): Row3d[] | null {
  if (rows !== null) return rows
  const anchor = engine.getEntityOrNullByName(ANCHOR_NAME)
  if (anchor === null) return null
  rows = Array.from({ length: ROWS }, (_, index) => createRow(anchor, index))
  return rows
}

function applyFace(row: Row3d) {
  const url = row.address === '' ? '' : (getLeaderboardFaceUrl(row.address) ?? FALLBACK_FACE_IMAGE)
  if (url === row.appliedFaceUrl) return
  row.appliedFaceUrl = url
  VisibilityComponent.getMutable(row.avatar).visible = url !== ''
  if (url === '') return
  Material.setBasicMaterial(row.avatar, { texture: Material.Texture.Common({ src: url }) })
}

// Counts code points, not UTF-16 units, so an emoji in a player's name doesn't get cut in half.
function truncateName(name: string): string {
  const chars = Array.from(name)
  if (chars.length <= NAME_MAX_CHARS) return name
  return chars.slice(0, NAME_MAX_CHARS).join('') + NAME_ELLIPSIS
}

export function updateLeaderboard3d(entries: Leaderboard3dEntry[]) {
  const built = ensureRows()
  if (built === null) return
  built.forEach((row, index) => {
    const entry = entries[index]
    row.address = entry?.address ?? ''
    TextShape.getMutable(row.rank).text = entry ? `${index + 1}.` : ''
    TextShape.getMutable(row.name).text = entry ? truncateName(entry.playerName) : ''
    TextShape.getMutable(row.score).text = entry ? `${entry.score}` : ''
    applyFace(row)
  })
}

export function setupLeaderboard3d() {
  engine.addSystem((dt: number) => {
    if (rows === null) return
    sinceFaceRefresh += dt
    if (sinceFaceRefresh < FACE_REFRESH_INTERVAL) return
    sinceFaceRefresh = 0
    for (const row of rows) applyFace(row)
  })
}
