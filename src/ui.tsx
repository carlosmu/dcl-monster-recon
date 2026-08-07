import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation, AudioSource, Transform, type Entity } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer } from '@dcl/sdk/players'
import checkpointsData from './checkpoints.json'
import { room } from './shared/messages'
import { setupCelebrationCamera, triggerCelebrationCamera, updateCelebrationCamera, triggerDefeatEmote } from './celebration'

const DEBUG_CELL_LABELS = false
const DEBUG_LAYOUT_BORDERS = true
// Debug layout border colors at 25% opacity, so they outline containers without obscuring the UI.
const DEBUG_BORDER_RED = Color4.create(1, 0, 0, 0.25)
const DEBUG_BORDER_GREEN = Color4.create(0, 1, 0, 0.25)
const DEBUG_BORDER_BLUE = Color4.create(0, 0, 1, 0.25)
const DEBUG_BORDER_WHITE = Color4.create(1, 1, 1, 0.25)
// Visual-only: shows every monster in the Codex as if collected, to check the prize sprite sheet.
// Does not touch real collection progress. Flip to false to see actual player progress.
const DEBUG_CODEX_SHOW_ALL_MONSTERS = false
// Visual-only: forces the header score display to a 5-digit value, to check it fits without
// overflowing the box. Does not touch the real score. Flip to false to see the actual score.
const DEBUG_SCORE_OVERRIDE = false

const BACK_IMAGE = 'assets/images/atlas_01.png'
const ATLAS_02_IMAGE = 'assets/images/atlas_02.png'
const AMBIENT_MUSIC_CLIP = 'assets/audio/Medieval_Astrology.mp3'
const BOARD_MUSIC_CLIP = 'assets/audio/jazzyfrenchy.mp3'
const BOARD_END_CLIP = 'assets/audio/tararan.mp3'
const TIMEOUT_CLIP = 'assets/audio/timeout.mp3'
const PRIZE_CLIP = 'assets/audio/fanfare.mp3'
const MATCH_CLIP = 'assets/audio/match.mp3'
const COUNTDOWN_CLIP = 'assets/audio/countdown.mp3'
const FAIL_CLIP = 'assets/audio/fail.mp3'
// Frame background shared by the memory-match board, checkpoint select, codex, and leaderboard
// screens. Cropped from atlas_02.png quadrants A1-D4 into its own file because nine-slicing in
// DCL only reads the full texture (no custom uvs).
const BOARD_FRAME_IMAGE = 'assets/images/frame_02.png'
// Fraction of the frame texture occupied by each corner ornament, measured so the wood/metal
// corners (and the baked-in close button) don't get stretched.
const FRAME_SLICE = 0.22
const BACK_ATLAS_GRID = 8 // atlas_01.png grid
const ALPHAS_IMAGE = 'assets/images/alphas.png'
const ALPHAS_GRID = 8 // alphas.png grid

// A "collection" is one full monster set: its own memory-match card art, its own prize sprite
// sheet, and its own rarity breakdown. To add a future collection, append a new entry here (with
// its own images and rarity counts) and append its checkpoints to checkpoints.json — existing
// collections' slot ranges, images, and any persisted player progress keyed off them are untouched.
interface RarityDef {
  label: string
  count: number
}

interface CollectionConfig {
  id: string
  cardImage: string // memory-match card faces (square grid)
  cardGrid: number
  prizeImage: string // monster prize sprites
  prizeGridCols: number
  prizeGridRows: number
  rarities: RarityDef[] // Common, Rare, Exotic, Epic, in that order
}

const COLLECTIONS: CollectionConfig[] = [
  {
    id: 'prizes_01',
    cardImage: 'assets/images/cards_01.png',
    cardGrid: 5,
    prizeImage: 'assets/images/prizes_01.png',
    prizeGridCols: 5,
    prizeGridRows: 4,
    rarities: [
      { label: 'Common', count: 8 },
      { label: 'Rare', count: 6 },
      { label: 'Exotic', count: 4 },
      { label: 'Epic', count: 2 }
    ]
  }
]

interface ResolvedRarity extends RarityDef {
  collection: ResolvedCollection
  start: number // global 0-based checkpoint/slot index, inclusive
  end: number
  rowSize: number
}

interface ResolvedCollection extends CollectionConfig {
  rarities: ResolvedRarity[]
  start: number // global 0-based checkpoint/slot index this collection starts at, inclusive
  end: number
}

// Assigns each collection (and each rarity within it) a contiguous slice of the global 0-based
// checkpoint/slot range, in COLLECTIONS order. A new collection appended at the end just continues
// the numbering — it never renumbers or collides with an earlier collection's slots.
const RESOLVED_COLLECTIONS: ResolvedCollection[] = (() => {
  let offset = 0
  return COLLECTIONS.map((collection) => {
    const start = offset
    // rarities is filled in below, once `resolved` itself exists, so each rarity can reference it.
    const resolved: ResolvedCollection = { ...collection, rarities: [], start, end: start }
    resolved.rarities = collection.rarities.map((r) => {
      const rarityStart = offset
      offset += r.count
      return { ...r, collection: resolved, start: rarityStart, end: offset - 1, rowSize: r.count }
    })
    resolved.end = offset - 1
    return resolved
  })
})()

function getCollectionForSlot(slot: number): ResolvedCollection {
  return RESOLVED_COLLECTIONS.find((c) => slot >= c.start && slot <= c.end) ?? RESOLVED_COLLECTIONS[0]
}

function getCollectionForCheckpoint(checkpoint: number): ResolvedCollection {
  return getCollectionForSlot(checkpoint - 1)
}

interface BoardConfig {
  cols: number
  rows: number
  duration: number
  flipTimeout: number
  scoreMultiplier: number
}

interface CheckpointConfig {
  boards: BoardConfig[]
}

// One entry per checkpoint; checkpoint N's monster is global slot N - 1, resolved to a collection
// and local sprite index via getCollectionForCheckpoint()/getCollectionForSlot(). This length must
// equal the sum of every COLLECTIONS[].rarities[].count — when appending a new collection, also
// append that many checkpoints here (new collections are added at the end, never inserted).
const CHECKPOINTS: CheckpointConfig[] = checkpointsData
const TOTAL_CHECKPOINTS = CHECKPOINTS.length

let COLS = CHECKPOINTS[0].boards[0].cols
let ROWS = CHECKPOINTS[0].boards[0].rows
let GAME_DURATION = CHECKPOINTS[0].boards[0].duration
let FLIP_TIMEOUT = CHECKPOINTS[0].boards[0].flipTimeout
let SCORE_MULTIPLIER = CHECKPOINTS[0].boards[0].scoreMultiplier

// Body text color for the memory board, checkpoint select, codex, and leaderboard screens.
const SCREEN_TEXT_COLOR = Color4.fromHexString('#2c180b')
// Screen title ("Select checkpoint", "Monster Codex", "Leaderboard"): matched to a 28px/1080px
// desktop look (x1.2), expressed in 'vh' so it scales with real screen size instead of a fixed px
// value. 'vh' alone still reads tiny on a small mobile screen (same reasoning as framePadding's
// isMobile() boost above), so it gets an extra x1.5 there.
const SCREEN_TITLE_FONT_SIZE_VH_NUM = (28 / 1080) * 100 * 1.2

function getScreenTitleFontSizeVh(): `${number}vh` {
  return `${SCREEN_TITLE_FONT_SIZE_VH_NUM * (isMobile() ? 1.5 : 1)}vh`
}

// Screen subtitle ("Best Time", "No scores yet"): 60% of the screen title size.
function getScreenSubtitleFontSizeVh(): `${number}vh` {
  return `${SCREEN_TITLE_FONT_SIZE_VH_NUM * (isMobile() ? 1.5 : 1) * 0.6}vh`
}
// Frame padding as a fraction of the real screen height, matched to a 48px/1080px desktop look.
const FRAME_PADDING_FRACTION = 48 / 1080
// Width of canvas_main (the safe-area column) as a fraction of screen width.
const CANVAS_MAIN_WIDTH_FRACTION = 0.4
// Memory-board grid container is width: '95%' of its frame (real, dynamic - see the JSX further
// down). Cell height is derived from that same real width fraction, in 'vw' - not from px computed
// from canvas.height, which drifts out of sync with the real % width whenever the player changes
// the client's render Resolution setting, deforming the cells (same issue fixed earlier for the
// Codex icons and checkpoint lock icons).
function getBoardCellHeightVw(cols: number): `${number}vw` {
  return `${(CANVAS_MAIN_WIDTH_FRACTION * 100 * 0.95) / cols}vw`
}
// Width is 10% of the containing frame (real, dynamic - every screen's frame is width: '100%' of
// canvas_main). Height can't be '%' of one's own width or 'auto' (there's no aspect-ratio prop,
// and an auto height on a childless background icon collapses to 0) - so it's derived as a 'vw'
// constant instead: 10% of a frame that's always CANVAS_MAIN_WIDTH_FRACTION * 100 vw wide.
const CLOSE_MUSIC_BUTTON_WIDTH_PERCENT = 10
const CLOSE_BUTTON_SIZE = `${CLOSE_MUSIC_BUTTON_WIDTH_PERCENT}%`
const CLOSE_BUTTON_HEIGHT_VW = `${(CLOSE_MUSIC_BUTTON_WIDTH_PERCENT / 100) * CANVAS_MAIN_WIDTH_FRACTION * 100}vw`
const MUSIC_BUTTON_SIZE = CLOSE_BUTTON_SIZE
// Fraction of canvas_main's height left for the body once the 10vh header and its 1vh top/bottom
// padding are subtracted. Used to size the Codex grid without overflowing past the header.
const CANVAS_MAIN_BODY_HEIGHT_FRACTION = 1 - 0.1 - 0.02
// Header row's 3 columns as fractions of the header row's width: left (score/leaderboard),
// middle (timer/play), right (codex/checkpoints) - must match the uiTransform widths below.
// Header has 2 children: left (score + timer/play, left-aligned) and right (leaderboard/codex/
// checkpoints icons, right-aligned) - must match the uiTransform widths below.
const HEADER_LEFT_COLUMN_FRACTION = 0.5

// The header row is width: '100%' of canvas_main (see the JSX below), so its real width is always
// CANVAS_MAIN_WIDTH_FRACTION * 100 vw. Left/right columns split that by HEADER_LEFT_COLUMN_FRACTION,
// so each column's width in 'vw' is known without ever reading canvas dimensions at runtime.
const HEADER_ROW_WIDTH_VW = CANVAS_MAIN_WIDTH_FRACTION * 100
const HEADER_LEFT_COLUMN_WIDTH_VW = HEADER_LEFT_COLUMN_FRACTION * HEADER_ROW_WIDTH_VW
const HEADER_RIGHT_COLUMN_WIDTH_VW = (1 - HEADER_LEFT_COLUMN_FRACTION) * HEADER_ROW_WIDTH_VW
// Right-hand header icon buttons (leaderboard/codex/checkpoints): width is 25% of their column
// (real, dynamic); height is derived from that column's known 'vw' width so they come out square
// without an aspect-ratio prop.
const HEADER_RIGHT_ICON_WIDTH_PERCENT = 25
const HEADER_RIGHT_ICON_SIZE = `${HEADER_RIGHT_ICON_WIDTH_PERCENT}%`
const HEADER_RIGHT_ICON_HEIGHT_VW = `${(HEADER_RIGHT_ICON_WIDTH_PERCENT / 100) * HEADER_RIGHT_COLUMN_WIDTH_VW}vw`
// TEST: same visual size as above (25% of a 20vw column ~ 96px at a 1920 reference), but as a
// raw px value relying on setUiRenderer's virtualWidth/virtualHeight to scale it, instead of the
// manual vw math above. If this reads correctly (including on mobile), migrate the rest to it.
const HEADER_RIGHT_ICON_SIZE_PX = 96
// Left-hand header boxes (score, timer): 40%-of-column width; height is derived from that same
// 'vw' width (not '%' or 'auto' - no aspect-ratio prop exists) to keep the 2:1 art undeformed.
const HEADER_LEFT_ICON_WIDTH_PERCENT = 50
const HEADER_LEFT_ICON_WIDTH = `${HEADER_LEFT_ICON_WIDTH_PERCENT}%`
const HEADER_LEFT_ICON_HEIGHT_VW_NUM = ((HEADER_LEFT_ICON_WIDTH_PERCENT / 100) * HEADER_LEFT_COLUMN_WIDTH_VW) / 2
const HEADER_LEFT_ICON_HEIGHT_VW = `${HEADER_LEFT_ICON_HEIGHT_VW_NUM}vw`
// Coin/timer icons inside those boxes: height is 60% of the box's own height; width uses that same
// 'vw' value (not '%') since the icon art is a square (1:1) UV block, so it stays undeformed.
const STAT_ICON_SIZE_VW = `${HEADER_LEFT_ICON_HEIGHT_VW_NUM * 0.6}vw`
// Label fontSize accepts a ScaleUnit ('Xvw'/'Xvh', not just raw px - see @dcl/react-ecs types), so
// text can scale with real screen size the same way the box itself does, instead of a fixed px
// value that looks tiny on large screens or overflows the box on small ones. Ratios below are
// fractions of the box's own height (which is fixed at half its width, i.e. these boxes are
// always 2:1) - kept conservative on the score side so a 5-digit score ("19999") still fits in
// the width left over after the icon, since box width scales in lockstep with box height (2:1).
const SCORE_FONT_SIZE_VW = `${HEADER_LEFT_ICON_HEIGHT_VW_NUM * 0.3}vw`
const TIMER_FONT_SIZE_VW = `${HEADER_LEFT_ICON_HEIGHT_VW_NUM * 0.37}vw`
// TEST: same visual sizes as the vw-derived values above (at a 1920 reference: box ~192x96,
// icon ~58, score font ~29, timer font ~36), but as raw px relying on virtualWidth/virtualHeight -
// same approach already confirmed working on the R header icons.
const HEADER_LEFT_BOX_WIDTH_PX = 192
const HEADER_LEFT_BOX_HEIGHT_PX = 96
const STAT_ICON_SIZE_PX = 58
const SCORE_FONT_SIZE_PX = 29
const TIMER_FONT_SIZE_PX = 36
// Play button lives in the body ("main") container while screen === 'hidden'. Width is 40% of
// that container (real, dynamic - width: '100%' of canvas_main); height is derived from the same
// 'vw' width so the 2:1 art (PLAY_BUTTON_UVS is a 4x2 atlas block) never deforms.
const PLAY_BUTTON_WIDTH_PERCENT = 25
const PLAY_BUTTON_WIDTH = `${PLAY_BUTTON_WIDTH_PERCENT}%`
const PLAY_BUTTON_HEIGHT_VW = `${((PLAY_BUTTON_WIDTH_PERCENT / 100) * CANVAS_MAIN_WIDTH_FRACTION * 100) / 2}vw`

const BASE_POINTS_PER_PAIR = 5
const TIME_BONUS_MAX = 10
const ERROR_PENALTY = 0.5

// Seconds the "Monster collected!" / "Time's up" screen stays up before the board closes on its own.
const END_SCREEN_DURATION = 3

// "MATCH!" popup: seconds it takes to float up and fade out, and how far (in px) it travels.
const MATCH_ANIM_DURATION = 0.7
const MATCH_FADE_IN_END = 0.1
const MATCH_FADE_OUT_START = 0.6
const MATCH_ANIM_DISTANCE = 60

// "Monster collected!" backdrop: continuous linear pulse from 1x to 2x and back to 1x.
const PRIZE_BACKDROP_SIZE = 270
const PRIZE_PULSE_PERIOD = 2 // seconds for a full 1x -> 2x -> 1x cycle
const PRIZE_PULSE_MAX_SCALE = 2

function getPrizePulseSize(): number {
  const phase = ((elapsedTime % PRIZE_PULSE_PERIOD) / PRIZE_PULSE_PERIOD) * 2 // 0..2
  const triangle = phase <= 1 ? phase : 2 - phase // 0..1..0
  const scale = 1 + triangle * (PRIZE_PULSE_MAX_SCALE - 1)
  return PRIZE_BACKDROP_SIZE * scale
}

// Timer text: below this many seconds remaining, it blinks white <-> red (ping-pong) instead of
// staying solid white.
const TIMER_LOW_TIME_THRESHOLD = 10
const TIMER_BLINK_PERIOD = 0.5 // seconds for a full white -> red -> white cycle

function getTimerColor(): Color4 {
  if (timeRemaining > TIMER_LOW_TIME_THRESHOLD) return Color4.White()
  const phase = ((elapsedTime % TIMER_BLINK_PERIOD) / TIMER_BLINK_PERIOD) * 2 // 0..2
  const triangle = phase <= 1 ? phase : 2 - phase // 0..1..0 - white (0) to red (1) and back
  return Color4.create(1, 1 - triangle, 1 - triangle, 1)
}

// "Paused" text (shown instead of the timer while a board is left open behind checkpoint
// select/codex/leaderboard): fades in and out via alpha, same ping-pong technique as the timer.
const PAUSED_BLINK_PERIOD = 0.8 // seconds for a full opaque -> faded -> opaque cycle

function getPausedBlinkColor(): Color4 {
  const phase = ((elapsedTime % PAUSED_BLINK_PERIOD) / PAUSED_BLINK_PERIOD) * 2 // 0..2
  const triangle = phase <= 1 ? phase : 2 - phase // 0..1..0
  return Color4.create(1, 1, 1, 0.3 + triangle * 0.7) // alpha 0.3..1..0.3
}

// UiTransform has no scale/transform prop, so a horizontal flip is done by mirroring the UVs.
const PRIZE_FLIP_INTERVAL = 0.5 // seconds between horizontal flips

function mirrorUvsHorizontal(uvs: number[]): number[] {
  return [uvs[6], uvs[7], uvs[4], uvs[5], uvs[2], uvs[3], uvs[0], uvs[1]]
}

// index is LOCAL to the collection's own prize grid (i.e. global slot minus the collection's start).
function getUvsForPrizeQuadrant(index: number, gridCols: number, gridRows: number): number[] {
  const col = index % gridCols
  const row = Math.floor(index / gridCols)
  const u1 = col / gridCols
  const u2 = (col + 1) / gridCols
  const v1 = (gridRows - row - 1) / gridRows
  const v2 = (gridRows - row) / gridRows
  return [u1, v1, u1, v2, u2, v2, u2, v1]
}

function getPrizeUvs(localIndex: number, gridCols: number, gridRows: number): number[] {
  const uvs = getUvsForPrizeQuadrant(localIndex, gridCols, gridRows)
  const flipped = Math.floor(elapsedTime / PRIZE_FLIP_INTERVAL) % 2 === 1
  return flipped ? mirrorUvsHorizontal(uvs) : uvs
}

// Pre-board countdown: "3, 2, 1", one second each, each number scaling up as it appears.
const COUNTDOWN_STEP_DURATION = 1
const COUNTDOWN_TOTAL_DURATION = 3
const COUNTDOWN_BASE_FONT_SIZE = 60
const COUNTDOWN_SCALE_MAX = 1.5
const COUNTDOWN_CIRCLE_SIZE = 160

// Placeholder notification copy — will be replaced with real event-driven messages later.
const NOTIFICATION_MESSAGES = [
  'Cryptonauta captured a mutant cucumber',
  '0xGorducho found a laser-eyed snail',
  'SatoshiWalker unearthed a toad with a space helmet',
  'PixelKilla caught a bioluminescent spider',
  'ByteHunter hunted down an octopus in a pilot cap'
]
const NOTIFICATION_INTERVAL = 10 // seconds between notifications
const NOTIFICATION_VISIBLE_DURATION = 4 // seconds each notification stays on screen
// Notification slide-in: starts 10vh below its resting position and slides up over this long.
const NOTIFICATION_SLIDE_DURATION = 0.5
const NOTIFICATION_SLIDE_DISTANCE_VH = 10

let framePadding = 16 // fallback until the first canvas read

function getUvsForBlock(col: number, row: number, colSpan: number, rowSpan: number, grid: number): number[] {
  const u1 = col / grid
  const u2 = (col + colSpan) / grid
  // v=0 is the bottom of the texture, v=1 is the top, so row 0 (A1, top row) must map to the topmost band
  const v1 = (grid - row - rowSpan) / grid
  const v2 = (grid - row) / grid
  // uvs go bottom-left, top-left, top-right, bottom-right (clockwise), per PBUiBackground
  return [u1, v1, u1, v2, u2, v2, u2, v1]
}

function getUvsForQuadrant(index: number, grid: number): number[] {
  return getUvsForBlock(index % grid, Math.floor(index / grid), 1, 1, grid)
}

// Card back art now spans a 2x2 block of atlas_01.png: A1, A2, B1, B2
const BACK_UVS = getUvsForBlock(0, 0, 2, 2, BACK_ATLAS_GRID)

// "Monster collected!" backdrop spans a 4x4 block of alphas.png: A1 to D4
const ALPHAS_COLLECTED_UVS = getUvsForBlock(0, 0, 4, 4, ALPHAS_GRID)

// Header button icons are 2x2 blocks of atlas_01.png.
const LEADERBOARD_BUTTON_UVS = getUvsForBlock(0, 4, 2, 2, BACK_ATLAS_GRID) // A5-B6
const CODEX_BUTTON_UVS = getUvsForBlock(0, 2, 2, 2, BACK_ATLAS_GRID) // A3-B4
const CHECKPOINTS_BUTTON_UVS = getUvsForBlock(2, 4, 2, 2, BACK_ATLAS_GRID) // C5-D6
const SCORE_BACKGROUND_UVS = getUvsForBlock(2, 0, 4, 2, BACK_ATLAS_GRID) // C1-F2
const PLAY_BUTTON_UVS = getUvsForBlock(2, 2, 4, 2, BACK_ATLAS_GRID) // C3-F4
const SCORE_ICON_UVS = getUvsForBlock(6, 4, 2, 2, BACK_ATLAS_GRID) // G5-H6
const TIMER_ICON_UVS = getUvsForBlock(4, 4, 2, 2, BACK_ATLAS_GRID) // E5-F6
const CLOSE_BUTTON_UVS = getUvsForBlock(4, 1, 1, 1, BACK_ATLAS_GRID) // atlas_02.png E2
const MUSIC_ON_UVS = getUvsForBlock(4, 2, 1, 1, BACK_ATLAS_GRID) // atlas_02.png E3
const MUSIC_OFF_UVS = getUvsForBlock(5, 2, 1, 1, BACK_ATLAS_GRID) // atlas_02.png F3
const LOCK_ICON_UVS = getUvsForBlock(6, 2, 1, 1, BACK_ATLAS_GRID) // atlas_02.png G3
const COUNTDOWN_BACKGROUND_UVS = getUvsForBlock(6, 2, 2, 2, BACK_ATLAS_GRID) // atlas_01.png G3-H4

interface CellState {
  frontQuadrant: number
  revealed: boolean
  matched: boolean
  flippedAt: number | null
}

// 'hidden' until the Play button (rendered in the body) opens the checkpoint select screen.
type Screen = 'hidden' | 'checkpointSelect' | 'board' | 'inventory' | 'leaderboard'

interface LeaderboardEntry {
  playerName: string
  score: number
}

let leaderboard: LeaderboardEntry[] = []

let screen: Screen = 'hidden'
// Set to 'board' when checkpointSelect/inventory/leaderboard is opened while a board is in
// progress, so closing it resumes that board instead of stranding it on 'hidden' (the timer
// already pauses on its own since it only ticks while screen === 'board').
let previousScreen: Screen | null = null
let currentCheckpoint = 1
let currentBoardIndex = 0 // 0-based index into the current checkpoint's boards array
// In-memory only for now — will be replaced by progress read from the authoritative server.
let highestUnlockedCheckpoint = 1
// One slot per checkpoint; true once that checkpoint's monster prize has been collected.
const collectedMonsters: boolean[] = new Array(TOTAL_CHECKPOINTS).fill(false)
// One slot per checkpoint; how many times that checkpoint's monster prize has been collected.
const collectionCounts: number[] = new Array(TOTAL_CHECKPOINTS).fill(0)
// Checkpoint-select grid is just a UI layout choice, independent of any collection's texture grids.
const CHECKPOINT_SELECT_COLS = 5
const CHECKPOINT_SELECT_ROWS = Math.ceil(TOTAL_CHECKPOINTS / CHECKPOINT_SELECT_COLS)
// Each button's aspect ratio (width:height). Expressed in 'vw' - not px - since the grid's width
// is always CANVAS_MAIN_WIDTH_FRACTION of the screen (90% of that, divided into COLS buttons),
// so a button's on-screen width is a fixed fraction of viewport width regardless of canvas.height.
// Deriving the row height as that same fraction * 4/5 keeps the buttons 5:4 without ever reading
// canvas dimensions at runtime.
const CHECKPOINT_SELECT_BUTTON_ASPECT = 4 / 5
const CHECKPOINT_SELECT_CELL_WIDTH_VW = (CANVAS_MAIN_WIDTH_FRACTION * 100 * 0.9) / CHECKPOINT_SELECT_COLS
const CHECKPOINT_SELECT_ROW_HEIGHT_VW = `${CHECKPOINT_SELECT_CELL_WIDTH_VW * CHECKPOINT_SELECT_BUTTON_ASPECT}vw`
// Buttons are 5:4 (wider than tall), but the lock artwork is square - sizing it off the button's
// width AND height (e.g. '60%'/'60%' of the cell) would stretch it to match the button's own 5:4
// shape. Deriving both dimensions from the same width-based vw value keeps it square instead.
const CHECKPOINT_SELECT_LOCK_ICON_SIZE_VW = `${CHECKPOINT_SELECT_CELL_WIDTH_VW * 0.6}vw`

// Rarity ranges by checkpoint slot index, flattened across all collections. Each rarity is laid
// out as a single row in the Codex (rowSize equals its slot count), with Exotic and Epic sharing
// one row per collection (see CODEX_GROUPS below).
const RARITIES: ResolvedRarity[] = RESOLVED_COLLECTIONS.flatMap((c) => c.rarities)

type RarityConfig = ResolvedRarity

function getRarityProgress(rarity: { start: number; end: number }): { collected: number; total: number } {
  let collected = 0
  for (let slot = rarity.start; slot <= rarity.end; slot++) {
    if (slot < TOTAL_CHECKPOINTS && collectedMonsters[slot]) collected++
  }
  return { collected, total: rarity.end - rarity.start + 1 }
}

// Groups of rarities laid out together in the Codex, one row per group. Within each collection,
// Exotic and Epic share a row (see the two-column layout with justify space-between in the render
// loop below). Assumes every collection declares exactly [Common, Rare, Exotic, Epic] in order.
const CODEX_GROUPS: RarityConfig[][] = RESOLVED_COLLECTIONS.flatMap((c) => [[c.rarities[0]], [c.rarities[1]], [c.rarities[2], c.rarities[3]]])

function getGroupDisplayTotal(group: RarityConfig[]): number {
  return group.reduce((sum, r) => sum + (r.end - r.start + 1), 0)
}

function getGroupRowSize(group: RarityConfig[]): number {
  return group.reduce((sum, r) => sum + r.rowSize, 0)
}

// Codex grid container is width: '95%' of canvas_main (see the JSX further down), so a group's
// row - and each icon within it - is always that same fixed fraction of the screen's width, in
// 'vw'. A rarity block is (rarity.rowSize / groupRowSize) of the row, and each icon within it is
// (1 / rarity.rowSize) of the block, so rarity.rowSize cancels out: every icon in a group ends up
// the same on-screen width, (CANVAS_MAIN_WIDTH_FRACTION * 95) / groupRowSize vw. Height is just
// that width * the aspect ratio - both in 'vw' so the icon can never deform, unlike the old
// px-from-canvas.height approach (see renderRarityBlock's comment).
const CODEX_ICON_HEIGHT_TO_WIDTH_RATIO = 1.25
function getCodexIconHeightVw(groupRowSize: number): `${number}vw` {
  const iconWidthVw = (CANVAS_MAIN_WIDTH_FRACTION * 100 * 0.95) / groupRowSize
  return `${iconWidthVw * CODEX_ICON_HEIGHT_TO_WIDTH_RATIO}vw`
}

// Each collection's prize sprite sheet may use a different grid, so its cells aren't necessarily
// square: on a square texture, a cell is taller than it is wide by cols/rows (e.g. a 5x4 grid on a
// square texture makes each cell 100 wide -> 125 tall). Stretching it into a square box would
// squash the art, so icon height is derived from width using that collection's own ratio.
function getPrizeCellAspect(collection: CollectionConfig): number {
  return collection.prizeGridCols / collection.prizeGridRows
}

// Locked-monster silhouette: same prize sprite, tinted black. PBUiBackground multiplies
// color * texture, so black (0,0,0) flattens every pixel's RGB to 0 regardless of the sprite's
// own shading, while its alpha (the silhouette shape) is preserved. Any non-zero tint would still
// show the sprite's original shading through, since multiply only scales existing brightness.
const LOCKED_MONSTER_TINT = Color4.create(0, 0, 0, 0.4)

// Renders one rarity's label ("Common 3/8") and its badge row(s).
// widthPercent is this block's share of the grid's width (100% for a standalone rarity, or its
// proportional share of a combined row like Exotic+Epic) - every width below it (row, icon) is a
// % of an ancestor, so this is the anchor that keeps them from resolving against nothing.
// iconHeight is a 'vw' string (not px, not %): height can't be expressed as a fraction of one's
// own width, and computing it from canvas.width/height at runtime (like we used to) breaks
// whenever the player changes the client's render Resolution setting - that setting skews
// UiCanvasInformation's reported canvas size without actually changing the real on-screen %
// layout, so px math derived from it drifts out of sync with the % width and the icon deforms.
// 'vw' sidesteps that: it's resolved by the UI layer against the true screen size, unaffected by
// that setting - see CHECKPOINT_SELECT_ROW_HEIGHT_VW above for the same fix applied earlier.
function renderRarityBlock(rarity: RarityConfig, widthPercent: number, iconHeightVw: `${number}vw`, marginRight: `${number}vh` | number = 0) {
  const { collected, total } = getRarityProgress(rarity)
  const rowSize = rarity.rowSize
  const rows = Math.ceil(total / rowSize)
  const slots = Array.from({ length: total }, (_, i) => rarity.start + i)
  const collection = rarity.collection
  const iconHeight = iconHeightVw
  return (
    <UiEntity
      key={rarity.label}
      uiTransform={{ width: `${widthPercent}%`, flexDirection: 'column', alignItems: 'flex-start', margin: { right: marginRight } }}
    >
      <Label value={`${rarity.label} ${collected}/${total}`} fontSize={24} color={SCREEN_TEXT_COLOR} uiTransform={{ margin: { top: '2vh', bottom: 0 } }} />
      {Array.from({ length: rows }, (_, rowIndex) => (
        <UiEntity key={rowIndex} uiTransform={{ width: '100%', height: iconHeight, flexDirection: 'row', justifyContent: 'flex-start' }}>
          {Array.from({ length: rowSize }, (_, colIndex) => {
            const indexInRarity = rowIndex * rowSize + colIndex
            if (indexInRarity >= slots.length) return null
            const slot = slots[indexInRarity]
            const collectedSlot = slot < TOTAL_CHECKPOINTS && (DEBUG_CODEX_SHOW_ALL_MONSTERS || collectedMonsters[slot])
            return (
              <UiEntity
                key={slot}
                uiTransform={{
                  width: `${100 / rowSize}%`,
                  minWidth: `${100 / rowSize}%`,
                  height: iconHeight,
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: 0
                }}
                uiBackground={
                  slot < TOTAL_CHECKPOINTS
                    ? {
                        textureMode: 'stretch',
                        texture: { src: collection.prizeImage },
                        uvs: getUvsForPrizeQuadrant(slot - collection.start, collection.prizeGridCols, collection.prizeGridRows),
                        color: collectedSlot ? undefined : LOCKED_MONSTER_TINT
                      }
                    : { color: Color4.create(0, 0, 0, 0.5) }
                }
              >
                {collectedSlot && collectionCounts[slot] > 0 && (
                  <Label
                    value={`x${collectionCounts[slot]}`}
                    fontSize={18}
                    color={Color4.Yellow()}
                    textAlign="middle-right"
                    uiTransform={{
                      positionType: 'absolute',
                      position: { top: 2, right: 2 }
                    }}
                  />
                )}
              </UiEntity>
            )
          })}
        </UiEntity>
      ))}
    </UiEntity>
  )
}

function getRarityLabel(slot: number): string {
  const rarity = RARITIES.find((r) => slot >= r.start && slot <= r.end)
  return rarity ? rarity.label : ''
}


let cells: CellState[] = []
// The memory-match card art for the checkpoint currently being played; set by startBoard() from
// that checkpoint's collection.
let currentCardImage = COLLECTIONS[0].cardImage
let currentCardGrid = COLLECTIONS[0].cardGrid
let elapsedTime = 0
let revealedUnmatched: CellState[] = []
let timeRemaining = GAME_DURATION
let gameOver = false
let won = false
let checkpointComplete = false
let showingPrize = false
let wonMonsterQuadrant = 0
let errors = 0
let score = 0
let totalScore = 0
let endScreenShownAt: number | null = null

let notificationTimer = 0
let currentNotification: string | null = null
let matchAnimStart: number | null = null
let countdownStart: number | null = null
let musicMuted = false

let lastServerTick = 0
let lastServerTickAt: number | null = null

const NO_BEST_TIME = -1
// Personal best times per board, keyed by bestTimeKey(checkpoint, boardIndex). -1 means no record yet.
const personalBests: Record<string, number> = {}

function bestTimeKey(checkpoint: number, boardIndex: number): string {
  return `${checkpoint}-${boardIndex}`
}

let lastBoardTime = 0
let isNewBestTime = false
const SERVER_OFFLINE_THRESHOLD = 3 // seconds without a tick before we consider the server offline

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function buildCells(): CellState[] {
  const pairCount = (COLS * ROWS) / 2
  const pool = Array.from({ length: currentCardGrid * currentCardGrid }, (_, i) => i)
  shuffle(pool)
  const values = [...pool.slice(0, pairCount), ...pool.slice(0, pairCount)]
  shuffle(values)
  return values.map((frontQuadrant) => ({ frontQuadrant, revealed: false, matched: false, flippedAt: null }))
}

function hideCell(cell: CellState) {
  cell.revealed = false
  cell.flippedAt = null
}

function flipCell(cell: CellState) {
  if (gameOver || countdownStart !== null || cell.matched || cell.revealed) return

  // A 3rd flip while 2 are still face-up (mismatched, not yet timed out) forces both to hide first.
  if (revealedUnmatched.length === 2) {
    for (const c of revealedUnmatched) hideCell(c)
    revealedUnmatched = []
  }

  cell.revealed = true
  cell.flippedAt = elapsedTime
  revealedUnmatched.push(cell)

  if (revealedUnmatched.length === 2) {
    const [a, b] = revealedUnmatched
    if (a.frontQuadrant === b.frontQuadrant) {
      a.matched = true
      b.matched = true
      revealedUnmatched = []
      matchAnimStart = elapsedTime
      playMatchSound()
      if (cells.every((c) => c.matched)) {
        won = true
        playBoardEndSound()
        const pairCount = (COLS * ROWS) / 2
        const timeBonus = Math.round((timeRemaining / GAME_DURATION) * TIME_BONUS_MAX * SCORE_MULTIPLIER)
        score = Math.max(0, Math.round(pairCount * BASE_POINTS_PER_PAIR * SCORE_MULTIPLIER + timeBonus - errors * ERROR_PENALTY))
        totalScore += score
        reportScore(score)
        lastBoardTime = GAME_DURATION - timeRemaining
        const previousBest = personalBests[bestTimeKey(currentCheckpoint, currentBoardIndex)]
        isNewBestTime = previousBest === undefined || previousBest === NO_BEST_TIME || lastBoardTime < previousBest
        triggerCelebrationCamera(isNewBestTime ? 'disco' : 'handsair', 0)
        room.send('reportBoardTime', {
          checkpoint: currentCheckpoint,
          boardIndex: currentBoardIndex,
          timeSeconds: lastBoardTime
        })

        const boardsInCheckpoint = CHECKPOINTS[currentCheckpoint - 1].boards.length
        checkpointComplete = currentBoardIndex === boardsInCheckpoint - 1
        if (checkpointComplete) {
          wonMonsterQuadrant = currentCheckpoint - 1
          collectedMonsters[currentCheckpoint - 1] = true
          collectionCounts[currentCheckpoint - 1]++
          if (currentCheckpoint === highestUnlockedCheckpoint && highestUnlockedCheckpoint < TOTAL_CHECKPOINTS) {
            highestUnlockedCheckpoint++
          }
        }
        endScreenShownAt = elapsedTime
      }
    } else {
      errors++
      playFailSound()
    }
  }
}

let ambientMusicEntity: Entity
let boardMusicEntity: Entity
let boardEndEntity: Entity
let prizeEntity: Entity
let matchEntity: Entity
let countdownEntity: Entity
let failEntity: Entity
let timeoutEntity: Entity

function playAmbientMusic() {
  if (musicMuted) return
  AudioSource.getMutable(ambientMusicEntity).playing = true
}

function stopAmbientMusic() {
  AudioSource.getMutable(ambientMusicEntity).playing = false
}

function playBoardMusic() {
  stopAmbientMusic()
  if (musicMuted) return
  AudioSource.getMutable(boardMusicEntity).playing = true
}

function stopBoardMusic() {
  AudioSource.getMutable(boardMusicEntity).playing = false
}

function toggleMusic() {
  musicMuted = !musicMuted
  if (musicMuted) {
    stopBoardMusic()
    stopAmbientMusic()
  } else if (screen === 'board' && !gameOver && !won && countdownStart === null) {
    playBoardMusic()
  } else {
    playAmbientMusic()
  }
}

function playBoardEndSound() {
  // playSound() always emits a CRDT PUT, so repeated calls reliably retrigger from the start
  // (unlike toggling `playing` directly, which can collapse same-tick writes and no-op).
  AudioSource.playSound(boardEndEntity, BOARD_END_CLIP, true)
}

function playTimeoutSound() {
  AudioSource.playSound(timeoutEntity, TIMEOUT_CLIP, true)
}

function playPrizeSound() {
  AudioSource.playSound(prizeEntity, PRIZE_CLIP, true)
}

function playMatchSound() {
  AudioSource.playSound(matchEntity, MATCH_CLIP, true)
}

function playCountdownSound() {
  AudioSource.playSound(countdownEntity, COUNTDOWN_CLIP, true)
}

function playFailSound() {
  AudioSource.playSound(failEntity, FAIL_CLIP, true)
}

function reportScore(points: number) {
  // room.send() queues automatically until the room is ready, so no readiness check is needed here.
  const playerName = getPlayer()?.name ?? 'Unknown'
  room.send('reportScore', { playerName, points })
}

export function setupUi() {
  cells = buildCells()

  ambientMusicEntity = engine.addEntity()
  Transform.create(ambientMusicEntity)
  AudioSource.create(ambientMusicEntity, { audioClipUrl: AMBIENT_MUSIC_CLIP, playing: true, loop: true, volume: 0.1, global: true })

  boardMusicEntity = engine.addEntity()
  Transform.create(boardMusicEntity)
  AudioSource.create(boardMusicEntity, { audioClipUrl: BOARD_MUSIC_CLIP, playing: false, loop: true, volume: 0.5, global: true })

  boardEndEntity = engine.addEntity()
  Transform.create(boardEndEntity)
  AudioSource.create(boardEndEntity, { audioClipUrl: BOARD_END_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  prizeEntity = engine.addEntity()
  Transform.create(prizeEntity)
  AudioSource.create(prizeEntity, { audioClipUrl: PRIZE_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  matchEntity = engine.addEntity()
  Transform.create(matchEntity)
  AudioSource.create(matchEntity, { audioClipUrl: MATCH_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  countdownEntity = engine.addEntity()
  Transform.create(countdownEntity)
  AudioSource.create(countdownEntity, { audioClipUrl: COUNTDOWN_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  failEntity = engine.addEntity()
  Transform.create(failEntity)
  AudioSource.create(failEntity, { audioClipUrl: FAIL_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  timeoutEntity = engine.addEntity()
  Transform.create(timeoutEntity)
  AudioSource.create(timeoutEntity, { audioClipUrl: TIMEOUT_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  setupCelebrationCamera()

  room.onMessage('leaderboardUpdate', (data) => {
    leaderboard = data.entries
  })

  room.onMessage('serverTick', (data) => {
    lastServerTick = data.tick
    lastServerTickAt = elapsedTime
  })

  room.onMessage('personalBestUpdate', (data) => {
    personalBests[bestTimeKey(data.checkpoint, data.boardIndex)] = data.bestTimeSeconds
  })

  // TEST: virtualWidth/virtualHeight lets the renderer scale raw-px sizes to fit any real screen,
  // per the build-ui skill. Trying it out on the R header icons first (see HEADER_RIGHT_ICON_SIZE_PX)
  // before migrating the rest of the manual vw/vh sizing done elsewhere in this file.
  ReactEcsRenderer.setUiRenderer(MemoryMatchUi, { virtualWidth: 1920, virtualHeight: 1080 })
  engine.addSystem((dt: number) => {
    elapsedTime += dt
    if (matchAnimStart !== null && elapsedTime - matchAnimStart >= MATCH_ANIM_DURATION) {
      matchAnimStart = null
    }
    if (countdownStart !== null && elapsedTime - countdownStart >= COUNTDOWN_TOTAL_DURATION) {
      countdownStart = null
      playBoardMusic()
    }
    if (revealedUnmatched.length > 0) {
      revealedUnmatched = revealedUnmatched.filter((cell) => {
        if (cell.flippedAt !== null && elapsedTime - cell.flippedAt >= FLIP_TIMEOUT) {
          hideCell(cell)
          return false
        }
        return true
      })
    }

    updateCelebrationCamera(dt)

    if (screen === 'board' && !gameOver && !won && countdownStart === null) {
      timeRemaining = Math.max(0, timeRemaining - dt)
      if (timeRemaining === 0) {
        gameOver = true
        stopBoardMusic()
        playTimeoutSound()
        triggerDefeatEmote()
        endScreenShownAt = elapsedTime
      }
    }

    if (endScreenShownAt !== null && elapsedTime - endScreenShownAt >= END_SCREEN_DURATION) {
      if (won && !checkpointComplete) {
        startBoard(currentCheckpoint, currentBoardIndex + 1)
      } else if (won && checkpointComplete && !showingPrize) {
        showingPrize = true
        stopBoardMusic()
        playPrizeSound()
        triggerCelebrationCamera('fistpump', 180)
        endScreenShownAt = elapsedTime
      } else {
        screen = 'checkpointSelect'
        playAmbientMusic()
        won = false
        gameOver = false
        checkpointComplete = false
        showingPrize = false
        endScreenShownAt = null
      }
    }

    notificationTimer += dt
    if (notificationTimer >= NOTIFICATION_INTERVAL) {
      notificationTimer = 0
      currentNotification = NOTIFICATION_MESSAGES[Math.floor(Math.random() * NOTIFICATION_MESSAGES.length)]
    } else if (currentNotification !== null && notificationTimer >= NOTIFICATION_VISIBLE_DURATION) {
      currentNotification = null
    }

    const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (canvas) {
      const basePadding = Math.round(FRAME_PADDING_FRACTION * canvas.height)
      framePadding = isMobile() ? Math.round(basePadding * 1.5) : basePadding

    }
  })
}

export function showCheckpointSelect() {
  if (screen === 'board') previousScreen = 'board'
  screen = 'checkpointSelect'
}

function startBoard(checkpoint: number, boardIndex: number) {
  const config = CHECKPOINTS[checkpoint - 1].boards[boardIndex]
  currentCheckpoint = checkpoint
  currentBoardIndex = boardIndex
  COLS = config.cols
  ROWS = config.rows
  GAME_DURATION = config.duration
  FLIP_TIMEOUT = config.flipTimeout
  SCORE_MULTIPLIER = config.scoreMultiplier

  const collection = getCollectionForCheckpoint(checkpoint)
  currentCardImage = collection.cardImage
  currentCardGrid = collection.cardGrid

  cells = buildCells()
  revealedUnmatched = []
  screen = 'board'
  timeRemaining = GAME_DURATION
  gameOver = false
  won = false
  checkpointComplete = false
  showingPrize = false
  errors = 0
  score = 0
  endScreenShownAt = null
  countdownStart = elapsedTime
  playCountdownSound()
  room.send('requestBestTime', { checkpoint, boardIndex })
}

function startCheckpoint(checkpoint: number) {
  startBoard(checkpoint, 0)
}

function closeBoard() {
  stopBoardMusic()
  playAmbientMusic()
  screen = 'checkpointSelect'
  gameOver = false
  won = false
  checkpointComplete = false
  showingPrize = false
  endScreenShownAt = null
  countdownStart = null
}

function closeCheckpointSelect() {
  screen = previousScreen === 'board' ? 'board' : 'hidden'
  previousScreen = null
}

function showInventory() {
  if (screen === 'board') previousScreen = 'board'
  screen = 'inventory'
}

function closeInventory() {
  screen = previousScreen === 'board' ? 'board' : 'hidden'
  previousScreen = null
}

function showLeaderboard() {
  if (screen === 'board') previousScreen = 'board'
  screen = 'leaderboard'
}

function closeLeaderboard() {
  screen = previousScreen === 'board' ? 'board' : 'hidden'
  previousScreen = null
}

const MemoryMatchUi = () => (
  <UiEntity
    uiTransform={{
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      alignItems: 'center'
    }}
    uiBackground={{ color: screen === 'board' ? Color4.create(0, 0, 0, 0.2) : Color4.create(0, 0, 0, 0) }}
  >
    {/* canvas_main: the safe-area column. Reserves 8% top/bottom for the system bar and stays
        within the 30%-75% horizontal safe zone (40% wide, centered). Reuse this for all scene UI;
        a sibling "canvas-sidebar" can be added later for anything that belongs outside this column. */}
    <UiEntity
      uiTransform={{
        width: `${CANVAS_MAIN_WIDTH_FRACTION * 100}%`,
        height: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: { top: '1vh', bottom: '1vh' },
        borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
        borderColor: DEBUG_BORDER_GREEN
      }}
    >
      {/* header: score+timer/play (left) | leaderboard+codex+checkpoints (right) */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 'auto',
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
          borderColor: DEBUG_BORDER_RED
        }}
      >
        <UiEntity
          uiTransform={{
            width: `${HEADER_LEFT_COLUMN_FRACTION * 100}%`,
            height: 'auto',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
            borderColor: DEBUG_BORDER_WHITE
          }}
        >
          <UiEntity
            uiTransform={{
              width: HEADER_LEFT_BOX_WIDTH_PX,
              height: HEADER_LEFT_BOX_HEIGHT_PX,
              flexShrink: 0,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: { left: '2vh', right: '2vh' },
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: DEBUG_BORDER_WHITE
            }}
          >
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}
              uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_BACKGROUND_UVS }}
            />
            <UiEntity uiTransform={{ width: STAT_ICON_SIZE_PX, height: STAT_ICON_SIZE_PX, flexShrink: 0 }} uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_ICON_UVS }} />
            <Label
              value={DEBUG_SCORE_OVERRIDE ? '99.999' : `${totalScore}`}
              fontSize={SCORE_FONT_SIZE_PX}
              textWrap="nowrap"
              textAlign="middle-right"
              color={Color4.White()}
            />
          </UiEntity>

          {(screen === 'board' || previousScreen === 'board') && (
            <UiEntity
              uiTransform={{
                width: HEADER_LEFT_BOX_WIDTH_PX,
                height: HEADER_LEFT_BOX_HEIGHT_PX,
                flexShrink: 0,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                margin: { left: 8 },
                padding: { left: '2vh', right: '2vh' },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            >
              <UiEntity
                uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}
                uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_BACKGROUND_UVS }}
              />
              <UiEntity uiTransform={{ width: STAT_ICON_SIZE_PX, height: STAT_ICON_SIZE_PX, flexShrink: 0 }} uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: TIMER_ICON_UVS }} />
              {screen === 'board' ? (
                <Label value={`${Math.ceil(timeRemaining)}s`} fontSize={TIMER_FONT_SIZE_PX} textWrap="nowrap" textAlign="middle-center" color={getTimerColor()} />
              ) : (
                <Label value="Paused" fontSize={SCORE_FONT_SIZE_PX} textWrap="nowrap" textAlign="middle-center" color={getPausedBlinkColor()} />
              )}
            </UiEntity>
          )}
        </UiEntity>

        <UiEntity
          uiTransform={{
            width: `${(1 - HEADER_LEFT_COLUMN_FRACTION) * 100}%`,
            height: 'auto',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
            borderColor: DEBUG_BORDER_WHITE
          }}
        >
          <UiEntity uiTransform={{ width: HEADER_RIGHT_ICON_SIZE_PX, height: HEADER_RIGHT_ICON_SIZE_PX, flexShrink: 0 }} onMouseDown={() => showLeaderboard()}>
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}
              uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: LEADERBOARD_BUTTON_UVS }}
            />
          </UiEntity>
          <UiEntity uiTransform={{ width: HEADER_RIGHT_ICON_SIZE_PX, height: HEADER_RIGHT_ICON_SIZE_PX, flexShrink: 0, margin: { left: 8 } }} onMouseDown={() => showInventory()}>
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}
              uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: CODEX_BUTTON_UVS }}
            />
          </UiEntity>
          <UiEntity uiTransform={{ width: HEADER_RIGHT_ICON_SIZE_PX, height: HEADER_RIGHT_ICON_SIZE_PX, flexShrink: 0, margin: { left: 8 } }} onMouseDown={() => showCheckpointSelect()}>
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}
              uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: CHECKPOINTS_BUTTON_UVS }}
            />
          </UiEntity>
        </UiEntity>
      </UiEntity>

      {/* body */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          padding: { top: '2vh', bottom: '2vh' },
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
          borderColor: DEBUG_BORDER_RED
        }}
      >
        {screen === 'hidden' && (
          <UiEntity
            uiTransform={{
              width: PLAY_BUTTON_WIDTH,
              height: PLAY_BUTTON_HEIGHT_VW,
              flexShrink: 0,
              positionType: 'absolute',
              // Centered in the body's top third: left keeps it horizontally centered ((100% -
              // PLAY_BUTTON_WIDTH_PERCENT) / 2), top sits it around the middle of the 0-33% band.
              position: { top: '12%', left: `${(100 - PLAY_BUTTON_WIDTH_PERCENT) / 2}%` }
            }}
            uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: PLAY_BUTTON_UVS }}
            onMouseDown={() => startCheckpoint(highestUnlockedCheckpoint)}
          />
        )}

        {screen === 'board' && !won && !gameOver && countdownStart !== null && (
          (() => {
            const elapsed = elapsedTime - countdownStart
            const value = 3 - Math.floor(elapsed / COUNTDOWN_STEP_DURATION)
            const stepProgress = (elapsed % COUNTDOWN_STEP_DURATION) / COUNTDOWN_STEP_DURATION
            const fontSize = COUNTDOWN_BASE_FONT_SIZE * (1 + (COUNTDOWN_SCALE_MAX - 1) * stepProgress)
            return (
              <UiEntity
                uiTransform={{
                  width: COUNTDOWN_CIRCLE_SIZE,
                  height: COUNTDOWN_CIRCLE_SIZE,
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: COUNTDOWN_BACKGROUND_UVS }}
              >
                <Label value={`${value}`} fontSize={fontSize} color={Color4.White()} textAlign="middle-center" />
              </UiEntity>
            )
          })()
        )}

        {screen === 'board' && !won && !gameOver && countdownStart === null && (
          <UiEntity
            uiTransform={{
              width: '100%',
              height: 'auto',
              minHeight: '60%',
              maxHeight: '100%',
              flexDirection: 'column',
              alignItems: 'center',
              padding: framePadding,
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: DEBUG_BORDER_RED
            }}
            uiBackground={{
              textureMode: 'nine-slices',
              texture: { src: BOARD_FRAME_IMAGE },
              textureSlices: { top: FRAME_SLICE, bottom: FRAME_SLICE, left: FRAME_SLICE, right: FRAME_SLICE }
            }}
          >
            <UiEntity
              uiTransform={{
                width: MUSIC_BUTTON_SIZE,
                height: CLOSE_BUTTON_HEIGHT_VW,
                positionType: 'absolute',
                // 1% inset + CLOSE_BUTTON_SIZE (10%) + 1% gap, in the same % unit as the button
                // widths themselves, so this never drifts out of sync with them like a vh offset
                // paired with a % width would (that mismatch caused the earlier overlap).
                position: { top: '1vh', right: `${1 + CLOSE_MUSIC_BUTTON_WIDTH_PERCENT + 1}%` },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: musicMuted ? MUSIC_OFF_UVS : MUSIC_ON_UVS }}
              onMouseDown={() => toggleMusic()}
            />
            <UiEntity
              uiTransform={{
                width: CLOSE_BUTTON_SIZE,
                height: CLOSE_BUTTON_HEIGHT_VW,
                positionType: 'absolute',
                position: { top: '1vh', right: '1%' },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeBoard()}
            />
            <Label
              value={`Checkpoint ${currentCheckpoint} · Board ${currentBoardIndex + 1}/${CHECKPOINTS[currentCheckpoint - 1].boards.length}`}
              fontSize={28}
              color={SCREEN_TEXT_COLOR}
              uiTransform={{
                margin: { bottom: 4 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            />
            <Label
              value={(() => {
                const best = personalBests[bestTimeKey(currentCheckpoint, currentBoardIndex)]
                return best === undefined || best === NO_BEST_TIME ? 'Best Time: --' : `Best Time: ${best.toFixed(1)}s`
              })()}
              fontSize={getScreenSubtitleFontSizeVh()}
              color={SCREEN_TEXT_COLOR}
              uiTransform={{
                margin: { bottom: 12 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            />
            <UiEntity
              uiTransform={{
                width: '95%',
                height: 'auto',
                flexDirection: 'column',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            >
              {Array.from({ length: ROWS }, (_, rowIndex) => (
                  <UiEntity
                    key={rowIndex}
                    uiTransform={{
                      width: '100%',
                      height: getBoardCellHeightVw(COLS),
                      flexDirection: 'row',
                      borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                      borderColor: DEBUG_BORDER_GREEN
                    }}
                  >
                    {cells.slice(rowIndex * COLS, rowIndex * COLS + COLS).map((cell, colIndex) => (
                      <UiEntity
                        key={rowIndex * COLS + colIndex}
                        uiTransform={{
                          width: `${100 / COLS}%`,
                          height: getBoardCellHeightVw(COLS)
                        }}
                        uiBackground={
                          cell.revealed
                            ? { textureMode: 'stretch', texture: { src: currentCardImage }, uvs: getUvsForQuadrant(cell.frontQuadrant, currentCardGrid) }
                            : { textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: BACK_UVS }
                        }
                        onMouseDown={() => flipCell(cell)}
                      >
                        {DEBUG_CELL_LABELS && (
                          <Label
                            value={`${String.fromCharCode(65 + colIndex)}${rowIndex + 1}`}
                            fontSize={28}
                            color={Color4.Yellow()}
                            textAlign="middle-center"
                            uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
                          />
                        )}
                      </UiEntity>
                    ))}
                  </UiEntity>
                ))}

              {matchAnimStart !== null &&
                (() => {
                  const elapsed = elapsedTime - matchAnimStart
                  const progress = Math.min(1, elapsed / MATCH_ANIM_DURATION)
                  let opacity: number
                  if (elapsed < MATCH_FADE_IN_END) {
                    opacity = elapsed / MATCH_FADE_IN_END
                  } else if (elapsed < MATCH_FADE_OUT_START) {
                    opacity = 1
                  } else {
                    opacity = 1 - (elapsed - MATCH_FADE_OUT_START) / (MATCH_ANIM_DURATION - MATCH_FADE_OUT_START)
                  }
                  return (
                    <UiEntity
                      uiTransform={{
                        width: '100%',
                        height: '100%',
                        positionType: 'absolute',
                        position: { top: 0, left: 0 },
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      <Label
                        value="MATCH!"
                        fontSize={40}
                        color={Color4.create(1, 0.9, 0.2, opacity)}
                        textAlign="middle-center"
                        uiTransform={{ margin: { bottom: progress * MATCH_ANIM_DISTANCE } }}
                      />
                    </UiEntity>
                  )
                })()}

            </UiEntity>

          </UiEntity>
        )}

        {screen === 'checkpointSelect' && (
          <UiEntity
            uiTransform={{
              width: '100%',
              height: 'auto',
              minHeight: '80%',
              maxHeight: '100%',
              flexDirection: 'column',
              alignItems: 'center',
              padding: framePadding,
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: DEBUG_BORDER_RED
            }}
            uiBackground={{
              textureMode: 'nine-slices',
              texture: { src: BOARD_FRAME_IMAGE },
              textureSlices: { top: FRAME_SLICE, bottom: FRAME_SLICE, left: FRAME_SLICE, right: FRAME_SLICE }
            }}
          >
            <UiEntity
              uiTransform={{
                width: CLOSE_BUTTON_SIZE,
                height: CLOSE_BUTTON_HEIGHT_VW,
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeCheckpointSelect()}
            />
            <Label value="Select checkpoint" fontSize={getScreenTitleFontSizeVh()} color={SCREEN_TEXT_COLOR} uiTransform={{ margin: { top: 4 } }} />
            <UiEntity
              uiTransform={{
                width: '90%',
                height: 'auto',
                flexDirection: 'column',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            >
              {Array.from({ length: CHECKPOINT_SELECT_ROWS }, (_, rowIndex) => (
                <UiEntity
                  key={rowIndex}
                  uiTransform={{
                    width: '100%',
                    height: CHECKPOINT_SELECT_ROW_HEIGHT_VW,
                    flexDirection: 'row',
                    borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                    borderColor: DEBUG_BORDER_GREEN
                  }}
                >
                  {Array.from({ length: CHECKPOINT_SELECT_COLS }, (_, colIndex) => {
                    const checkpoint = rowIndex * CHECKPOINT_SELECT_COLS + colIndex + 1
                    if (checkpoint > TOTAL_CHECKPOINTS) {
                      return (
                        <UiEntity
                          key={checkpoint}
                          uiTransform={{
                            width: `${100 / CHECKPOINT_SELECT_COLS}%`,
                            minWidth: `${100 / CHECKPOINT_SELECT_COLS}%`,
                            height: '100%',
                            borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                            borderColor: DEBUG_BORDER_BLUE
                          }}
                        />
                      )
                    }
                    const unlocked = checkpoint <= highestUnlockedCheckpoint
                    return (
                      <UiEntity
                        key={checkpoint}
                        uiTransform={{
                          width: `${100 / CHECKPOINT_SELECT_COLS}%`,
                          minWidth: `${100 / CHECKPOINT_SELECT_COLS}%`,
                          height: '100%',
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                          borderColor: DEBUG_BORDER_BLUE
                        }}
                        uiBackground={{ color: unlocked ? Color4.create(0.2, 0.6, 0.9, 0.6) : Color4.create(0, 0, 0, 0.5) }}
                        onMouseDown={unlocked ? () => startCheckpoint(checkpoint) : undefined}
                      >
                        {unlocked ? (
                          <Label
                            value={String(checkpoint).padStart(2, '0')}
                            fontSize={35}
                            color={SCREEN_TEXT_COLOR}
                            textAlign="middle-center"
                          />
                        ) : (
                          <UiEntity
                            uiTransform={{ width: CHECKPOINT_SELECT_LOCK_ICON_SIZE_VW, height: CHECKPOINT_SELECT_LOCK_ICON_SIZE_VW }}
                            uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: LOCK_ICON_UVS }}
                          />
                        )}
                      </UiEntity>
                    )
                  })}
                </UiEntity>
              ))}
            </UiEntity>
          </UiEntity>
        )}

        {screen === 'inventory' && (
          <UiEntity
            uiTransform={{
              width: '100%',
              height: 'auto',
              minHeight: '80%',
              maxHeight: '100%',
              flexDirection: 'column',
              alignItems: 'center',
              padding: framePadding,
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: DEBUG_BORDER_RED
            }}
            uiBackground={{
              textureMode: 'nine-slices',
              texture: { src: BOARD_FRAME_IMAGE },
              textureSlices: { top: FRAME_SLICE, bottom: FRAME_SLICE, left: FRAME_SLICE, right: FRAME_SLICE }
            }}
          >
            <UiEntity
              uiTransform={{
                width: CLOSE_BUTTON_SIZE,
                height: CLOSE_BUTTON_HEIGHT_VW,
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeInventory()}
            />
            <Label
              value="Monster Codex"
              fontSize={getScreenTitleFontSizeVh()}
              color={SCREEN_TEXT_COLOR}
              uiTransform={{
                margin: { bottom: 12 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            />
            <UiEntity
              uiTransform={{
                width: '95%',
                flexDirection: 'column',
                alignItems: 'flex-start',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            >
              {CODEX_GROUPS.map((group) => {
                const groupRowSize = getGroupRowSize(group)
                const iconHeightVw = getCodexIconHeightVw(groupRowSize)
                return (
                  <UiEntity
                    key={group.map((r) => r.label).join('+')}
                    uiTransform={{
                      width: '100%',
                      flexDirection: 'row',
                      justifyContent: group.length > 1 ? 'space-between' : 'flex-start',
                      alignItems: 'flex-start',
                      margin: { bottom: '5vh' }
                    }}
                  >
                    {group.map((rarity, rarityIndex) =>
                      renderRarityBlock(rarity, (rarity.rowSize / groupRowSize) * 100, iconHeightVw, group.length > 1 && rarityIndex === 0 ? '2vh' : 0)
                    )}
                  </UiEntity>
                )
              })}
            </UiEntity>
          </UiEntity>
        )}

        {screen === 'leaderboard' && (
          <UiEntity
            uiTransform={{
              width: '100%',
              height: 'auto',
              minHeight: '80%',
              maxHeight: '100%',
              flexDirection: 'column',
              alignItems: 'center',
              padding: framePadding,
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: DEBUG_BORDER_RED
            }}
            uiBackground={{
              textureMode: 'nine-slices',
              texture: { src: BOARD_FRAME_IMAGE },
              textureSlices: { top: FRAME_SLICE, bottom: FRAME_SLICE, left: FRAME_SLICE, right: FRAME_SLICE }
            }}
          >
            <UiEntity
              uiTransform={{
                width: CLOSE_BUTTON_SIZE,
                height: CLOSE_BUTTON_HEIGHT_VW,
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeLeaderboard()}
            />
            <Label
              value="Leaderboard"
              fontSize={getScreenTitleFontSizeVh()}
              color={SCREEN_TEXT_COLOR}
              uiTransform={{
                margin: { bottom: 12 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            />
            <UiEntity
              uiTransform={{
                width: 300,
                flexDirection: 'column',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            >
              {leaderboard.length === 0 ? (
                <Label value="No scores yet" fontSize={getScreenSubtitleFontSizeVh()} color={SCREEN_TEXT_COLOR} textAlign="middle-center" />
              ) : (
                leaderboard.map((entry, index) => (
                  <UiEntity
                    key={index}
                    uiTransform={{
                      width: '100%',
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      padding: { top: 4, bottom: 4 },
                      borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                      borderColor: DEBUG_BORDER_GREEN
                    }}
                  >
                    <Label value={`${index + 1}. ${entry.playerName}`} fontSize={24} color={SCREEN_TEXT_COLOR} />
                    <Label value={`${entry.score}`} fontSize={16} color={SCREEN_TEXT_COLOR} />
                  </UiEntity>
                ))
              )}
            </UiEntity>
          </UiEntity>
        )}
      </UiEntity>

      {/* footer */}
      <UiEntity
        uiTransform={{
          width: '100%',
          minHeight: isMobile() ? '7.5vh' : '15vh',
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
          borderColor: DEBUG_BORDER_RED
        }}
      >
        {(() => {
          const serverOnline = lastServerTickAt !== null && elapsedTime - lastServerTickAt < SERVER_OFFLINE_THRESHOLD
          return (
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { bottom: 4, right: 4 }
              }}
            >
              <Label
                value={serverOnline ? `Server online (tick ${lastServerTick})` : 'Server offline'}
                fontSize={12}
                color={serverOnline ? Color4.create(0.2, 0.7, 0.3, 1) : Color4.create(0.9, 0.3, 0.3, 1)}
              />
            </UiEntity>
          )
        })()}
      </UiEntity>

    </UiEntity>

    {/* canvas-sidebar: sits to the right of canvas_main, outside its safe-area column. */}
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: '30vh', right: '2vh' },
        width: '25%',
        minHeight: 100,
        flexDirection: 'column',
        alignItems: 'center'
      }}
    >
      {currentNotification &&
        (() => {
          const slideProgress = Math.min(1, notificationTimer / NOTIFICATION_SLIDE_DURATION)
          const marginTopVh = (1 - slideProgress) * NOTIFICATION_SLIDE_DISTANCE_VH
          return (
            <UiEntity
              uiTransform={{
                width: '100%',
                margin: { top: `${marginTopVh}vh` },
                padding: { top: 10, bottom: 10, left: 20, right: 20 },
                borderRadius: 16
              }}
              uiBackground={{ color: Color4.fromHexString('#522c14') }}
            >
              <Label value={currentNotification} fontSize={24} color={Color4.White()} textAlign="middle-center" />
            </UiEntity>
          )
        })()}
    </UiEntity>

    {(won || gameOver) && (
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column'
        }}
      >
        {won ? (
          showingPrize ? (
            (() => {
              const wonCollection = getCollectionForSlot(wonMonsterQuadrant)
              const wonPrizeCellHeight = PRIZE_BACKDROP_SIZE * getPrizeCellAspect(wonCollection)
              return (
                <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
                  <Label
                    value={`${getRarityLabel(wonMonsterQuadrant)} Monster\nCollected!`}
                    fontSize={36}
                    color={Color4.White()}
                    textAlign="middle-center"
                  />
                  <UiEntity
                    uiTransform={{
                      width: PRIZE_BACKDROP_SIZE * PRIZE_PULSE_MAX_SCALE,
                      height: PRIZE_BACKDROP_SIZE * PRIZE_PULSE_MAX_SCALE,
                      margin: { top: 20 },
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    <UiEntity
                      uiTransform={{ width: getPrizePulseSize(), height: getPrizePulseSize() }}
                      uiBackground={{
                        textureMode: 'stretch',
                        texture: { src: ALPHAS_IMAGE },
                        uvs: ALPHAS_COLLECTED_UVS
                      }}
                    />
                    <UiEntity
                      uiTransform={{
                        width: PRIZE_BACKDROP_SIZE,
                        height: wonPrizeCellHeight,
                        positionType: 'absolute',
                        position: {
                          top: (PRIZE_BACKDROP_SIZE * PRIZE_PULSE_MAX_SCALE - wonPrizeCellHeight) / 2,
                          left: (PRIZE_BACKDROP_SIZE * PRIZE_PULSE_MAX_SCALE - PRIZE_BACKDROP_SIZE) / 2
                        }
                      }}
                      uiBackground={{
                        textureMode: 'stretch',
                        texture: { src: wonCollection.prizeImage },
                        uvs: getPrizeUvs(wonMonsterQuadrant - wonCollection.start, wonCollection.prizeGridCols, wonCollection.prizeGridRows)
                      }}
                    />
                  </UiEntity>
                </UiEntity>
              )
            })()
          ) : (
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
              <Label value="Board complete!" fontSize={36} color={Color4.White()} />
              <Label value={`+${score} pts`} fontSize={24} color={Color4.White()} uiTransform={{ margin: { top: 8 } }} />
              {isNewBestTime && (
                <Label
                  value={`New Best Time! ${lastBoardTime.toFixed(1)}s`}
                  fontSize={20}
                  color={Color4.White()}
                  uiTransform={{ margin: { top: 8 } }}
                />
              )}
            </UiEntity>
          )
        ) : (
          <Label value="Time's up" fontSize={36} color={Color4.White()} />
        )}
      </UiEntity>
    )}
  </UiEntity>
)
