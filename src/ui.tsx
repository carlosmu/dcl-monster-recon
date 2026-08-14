import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import {
  engine,
  AudioSource,
  Transform,
  UiCanvasInformation,
  type Entity
} from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer } from '@dcl/sdk/players'
import checkpointsData from './checkpoints.json'
import { BitmapText, GERM_ONE_FONT, GERM_ONE_IMAGE, GERM_ONE_IMAGE_BROWN } from './bitmapFont'
import { prefetchLeaderboardFaces, getLeaderboardFaceUrl } from './leaderboardProfileCache'
import { room } from './shared/messages'
import { guard, getCapturedError } from './errorTrap'
import {
  DEBUG_CELL_LABELS,
  DEBUG_LAYOUT_BORDERS,
  DEBUG_CANVAS_INFO,
  DEBUG_DUMP_BEST_TIMES,
  DEBUG_CODEX_SHOW_ALL_MONSTERS,
  DEBUG_SCORE_OVERRIDE,
  DEBUG_UNLOCK_ALL_CHECKPOINTS,
  DEBUG_BORDER_RED,
  DEBUG_BORDER_GREEN,
  DEBUG_BORDER_BLUE,
  DEBUG_BORDER_WHITE
} from './debugFlags'
import { setupCelebrationCamera, triggerCelebrationCamera, updateCelebrationCamera, triggerDefeatEmote } from './celebration'
import {
  startPrizeChase,
  updatePrizeChase,
  getPrizeChaseSecondsRemaining,
  getPrizeChaseChancesRemaining,
  stopPrizeChase,
  PRIZE_CHASE_MAX_ATTEMPTS
} from './prizeChase'

const BACK_IMAGE = 'assets/images/atlas_01.png'
const ATLAS_02_IMAGE = 'assets/images/atlas_02.png'
const AMBIENT_MUSIC_CLIP = 'assets/audio/ambient_01.mp3'
const BOARD_MUSIC_CLIP = 'assets/audio/jazzyfrenchy.mp3'
const BOARD_END_CLIP = 'assets/audio/get_points.mp3'
const TIMEOUT_CLIP = 'assets/audio/timeout.mp3'
const PRIZE_CLIP = 'assets/audio/collected.mp3'
const MATCH_CLIP = 'assets/audio/match.mp3'
const COUNTDOWN_CLIP = 'assets/audio/countdown.mp3'
const FAIL_CLIP = 'assets/audio/fail.mp3'
const TICKING_CLIP = 'assets/audio/ticking.mp3'
const LOSE_A_CHANCE_CLIP = 'assets/audio/lose_a_chance.mp3'
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
// Shown in the leaderboard when a wallet has no Decentraland profile (the lambdas endpoint 404s for
// guests and never-configured avatars) or while its face is still loading.
const FALLBACK_PROFILE_PIC_IMAGE = 'assets/images/fallback_profile_pic.png'

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
  // Same grid/coordinates as prizeImage, pre-rendered black at low opacity - used instead of
  // prizeImage + a runtime black tint for locked slots, since uiBackground.color tinting isn't
  // honored on mobile (same issue as the bitmap-font titles - see bitmapFont.tsx).
  prizeImageLocked: string
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
    prizeImageLocked: 'assets/images/prizes_01_not_collected.png',
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
// desktop look (x1.2), as raw px at the 1920x1080 virtual reference - scaled by
// virtualWidth/virtualHeight instead of the old 'vh' + manual isMobile() boost (no longer needed;
// the virtual-canvas scale factor already accounts for device screen size on its own).
const SCREEN_TITLE_FONT_SIZE_PX = 28 * 1.2
// Screen subtitle ("Best Time", "No scores yet"): 60% of the screen title size.
const SCREEN_SUBTITLE_FONT_SIZE_PX = SCREEN_TITLE_FONT_SIZE_PX * 0.6
// Leaderboard list: raw px at the 1920x1080 virtual reference, same approach as the constants above.
const LEADERBOARD_LIST_WIDTH_PX = 300
const LEADERBOARD_ROW_NAME_FONT_SIZE_PX = 24
const LEADERBOARD_ROW_SCORE_FONT_SIZE_PX = 24
// Fixed width for the "1." / "10." rank column - wide enough for 2 digits + the dot, so every
// row's rank is the same width and right-aligned (name column starts at the same x regardless of
// rank digit count).
const LEADERBOARD_RANK_WIDTH_PX = 40
// Profile picture (face256/face128 from the Decentraland lambdas profile, see
// leaderboardProfileCache.ts) - falls back to a solid gray circle while it's loading or if the
// fetch failed.
const LEADERBOARD_AVATAR_SIZE_PX = 42
// Frame padding for board/checkpointSelect/inventory/leaderboard's nine-slice frame. Raw px at
// the 1920x1080 virtual reference (matches the old 48px/1080px desktop look), scaled by
// virtualWidth/virtualHeight - replaces the old runtime UiCanvasInformation.height read, which
// would now double-scale (it already read the true screen height, then virtualHeight would scale
// it again).
const FRAME_PADDING_PX = 48
const FRAME_PADDING_MOBILE_PX = 72

function getFramePaddingPx(): number {
  return isMobile() ? FRAME_PADDING_MOBILE_PX : FRAME_PADDING_PX
}
// Width of canvas_main (the safe-area column) as a fraction of screen width. Narrower on mobile
// (35vw vs 40vw on desktop) - same 40vw felt too wide on narrow mobile screens.
const CANVAS_MAIN_WIDTH_FRACTION = 0.4
const CANVAS_MAIN_WIDTH_FRACTION_MOBILE = 0.35
// TEST: canvas_main's own width, as raw px (virtualWidth * fraction) instead of '%' of the real
// screen. This is the anchor fix for the header/L/R/body overflow bug on mobile: '%' NEVER goes
// through the virtualWidth/virtualHeight scale factor (only raw numbers do - confirmed by reading
// @dcl/react-ecs's uiTransform/utils.js), so a '%' chain all the way to the true screen (the old
// canvas_main) disagreed with the raw-px score/timer boxes inside it whenever height (not width)
// was the constraining axis for the scale factor (e.g. a landscape phone wider than 16:9). Anchoring
// canvas_main itself in raw px makes every '%' below it resolve against an already-correctly-scaled
// parent, so header/L/R/body stay consistent with the raw-px leaves without needing their own
// conversion. canvas_main's height stays '100%' on purpose - see comment at its uiTransform below.
function getCanvasMainWidthPx(): number {
  return (isMobile() ? CANVAS_MAIN_WIDTH_FRACTION_MOBILE : CANVAS_MAIN_WIDTH_FRACTION) * 1920
}
// TEST: canvas_main's top/bottom padding, body's top/bottom padding, and the footer's min height -
// same visual sizes as their old 'vh' values (1vh/2vh/7.5-15vh at a 1080 reference), as raw px
// relying on virtualWidth/virtualHeight, same approach as everything else converted so far.
const CANVAS_MAIN_PADDING_PX = 11
const BODY_PADDING_PX = 22
const FOOTER_MIN_HEIGHT_MOBILE_PX = 30
const FOOTER_MIN_HEIGHT_DESKTOP_PX = 100

// PROVISIONAL: board-progress pips (1/2/3), shown just below the header while playing through a
// checkpoint's 3 boards. Real screen units ('vh'/'%'), not raw px - this is a standalone strip,
// not mixed with any raw-px sibling, so there's no virtual-scale mismatch to worry about here.
const BOARD_PROGRESS_TOP_INSET_VH = '1vh'
const BOARD_PROGRESS_BAR_WIDTH_PERCENT = '60%'
const BOARD_PROGRESS_BAR_PADDING_VH = '0.3vh'
const BOARD_PROGRESS_BAR_COLOR = Color4.create(0, 0, 0, 1)
const BOARD_PROGRESS_PIP_SIZE_VH = '3.15vh'
const BOARD_PROGRESS_PIP_ACTIVE_COLOR = Color4.fromHexString('#2ecc71')
const BOARD_PROGRESS_PIP_INACTIVE_COLOR = Color4.create(1, 1, 1, 0.25)

// Visible from Play through the checkpoint's 3 boards (including the "Board complete!" toast
// between them) - hidden once the sequence moves into the prize chase, and on every other screen.
function showingBoardProgress(): boolean {
  return screen === 'board' && toastPhase !== 'findMonster' && toastPhase !== 'monsterCollected' && toastPhase !== 'monsterNotCollected'
}
// Memory-board grid container is width: '95%' of its frame (real, dynamic - see the JSX further
// down). Cells must stay square: mixing a '%' width (resolves against the real, already-scaled
// frame) with a 'vw' height (bypasses virtualWidth/virtualHeight entirely and reads the true
// viewport instead) stretches them whenever the virtual canvas' scale factor isn't 1:1 with real
// vw - which is exactly the case virtualWidth/virtualHeight was introduced to handle. So both
// width and height are raw px at the 1920x1080 virtual reference (matching canvas_main's own
// CANVAS_MAIN_WIDTH_PX anchor), scaled by the same factor as everything else - not '%'/'vw'.
// Available width is the frame's content box (CANVAS_MAIN_WIDTH_PX minus its own padding on both
// sides), same as getCodexIconSizePx/checkpoint-select icon sizing below - not the full
// CANVAS_MAIN_WIDTH_PX, which overshoots the real space inside the frame's padding.
// Lowered from 0.95: cell size (and thus total grid height, since cells are square) is driven
// entirely by width/cols, with no read of the frame's real available height - canvas_main's height
// stays real/'%' on purpose (see its own comment) while width is virtual-scaled raw px, so the two
// are never guaranteed to agree. Across every board in checkpoints.json the 4x4 boards already have
// the tallest rows/cols ratio in the game (1.0 - a 5x4 board is 0.8, shorter), so a cols/rows-aware
// cap can't target this: whatever real aspect ratio makes a 5x4 board overflow would make a 4x4
// board overflow at least as much. This fraction is the only lever that isn't board-specific - a
// smaller value buys more vertical headroom for every board uniformly. It doesn't guarantee a fit
// on every possible device aspect ratio (that needs the frame's real available height, e.g. via
// UiCanvasInformation - not done here), so overflow: 'hidden' on the frame (below) is the backstop.
const BOARD_GRID_WIDTH_FRACTION = 0.75
// Cells always fill the full grid width, whatever the row count - a height-derived cap here
// (tried previously) shrinks cells below the container width on boards with more rows (4x4, 5x4),
// leaving a gap on the right since the grid/row don't center leftover space. If a tall board
// (many rows, few cols) ever needs to fit a constrained vertical area again, that has to be solved
// without capping width - e.g. capping the grid's own font/padding budget, not the cell size.
function getBoardCellSizePx(cols: number): number {
  const availableWidth = getCanvasMainWidthPx() - 2 * getFramePaddingPx()
  return (availableWidth * BOARD_GRID_WIDTH_FRACTION) / cols
}
// Width is 10% of the containing frame (real, dynamic - every screen's frame is width: '100%' of
// canvas_main). Height can't be '%' of one's own width or 'auto' (there's no aspect-ratio prop,
// and an auto height on a childless background icon collapses to 0) - so it's derived as a 'vw'
// constant instead: 10% of a frame that's always CANVAS_MAIN_WIDTH_FRACTION * 100 vw wide.
const CLOSE_MUSIC_BUTTON_WIDTH_PERCENT = 10
const CLOSE_BUTTON_SIZE = `${CLOSE_MUSIC_BUTTON_WIDTH_PERCENT}%`
const CLOSE_BUTTON_HEIGHT_VW = `${(CLOSE_MUSIC_BUTTON_WIDTH_PERCENT / 100) * CANVAS_MAIN_WIDTH_FRACTION * 100}vw`
const MUSIC_BUTTON_SIZE = CLOSE_BUTTON_SIZE
// TEST: close (X) / music toggle buttons, square, as raw px at the 1920x1080 reference (10% of
// canvas_main's 768px-reference width), plus their position insets in the same raw-px system -
// mixing '%'/'vh' insets with a raw-px button size is exactly the bug fixed for score/timer.
const CLOSE_BUTTON_SIZE_PX = 76.8
const CLOSE_BUTTON_INSET_PX = 7.68 // 1% of the 768px-reference frame width
const CLOSE_BUTTON_TOP_INSET_PX = 10.8 // 1% of the 1080px virtual height
const MUSIC_BUTTON_RIGHT_INSET_PX = CLOSE_BUTTON_INSET_PX + CLOSE_BUTTON_SIZE_PX + CLOSE_BUTTON_INSET_PX
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
const HEADER_RIGHT_ICON_SIZE_PX = 90
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
const HEADER_LEFT_BOX_WIDTH_PX = 180
const HEADER_LEFT_BOX_HEIGHT_PX = 90
const STAT_ICON_SIZE_PX = 60
// Score and timer/"Paused" text share this one size now (bitmap font, header stat boxes) - the
// midpoint of the old separate score (30px) and timer (45px) sizes.
const STAT_FONT_SIZE_PX = 37.5
const HEADER_LEFT_BOX_PADDING_PX = 22
// Play button lives in the body ("main") container while screen === 'hidden'. Raw px at the
// 1920x1080 virtual reference, scaled by virtualWidth/virtualHeight like everything else here.
const PLAY_BUTTON_WIDTH_PX = 192
const PLAY_BUTTON_HEIGHT_PX = 96
// Bigger hit target on mobile, where fingers are less precise than a mouse cursor.
const PLAY_BUTTON_MOBILE_SCALE = 1.5

function getPlayButtonWidthPx(): number {
  return isMobile() ? PLAY_BUTTON_WIDTH_PX * PLAY_BUTTON_MOBILE_SCALE : PLAY_BUTTON_WIDTH_PX
}

// Glow behind the Play button: a dedicated glow sprite (PLAY_GLOW_UVS, atlas_01.png A7-D8), the
// same 4x2 atlas span as the button's own art (PLAY_BUTTON_UVS, C3-F4) - so the button's own real
// size is a valid reference for scaling this up. 1.5x so it visibly sticks out around the button.
// color stays white (no tint), only alpha pulses - same triangle-wave technique as other pulses.
const PLAY_GLOW_SCALE = 1.4
const PLAY_GLOW_MIN_OPACITY = 0.1
const PLAY_GLOW_MAX_OPACITY = 1

// Button+glow group scale (1x -> 1.2x -> 1x) and glow opacity (0.1 -> 1 -> 0.1) share the SAME
// period below, so max scale always lands exactly on max opacity in time - they just use different
// curve shapes (confirmed by ear: easeOutBack/easeInBack reads better for the scale pop, plain
// cosine reads better for the opacity fade). UiTransform has no scale prop, so scale is faked by
// animating the group's own box width/height - the outer anchor stays fixed at the button's base
// position/size, and the pulse is applied to a nested wrapper centered on that same point (top/left
// 50% + negative margin), so it grows/shrinks symmetrically in place rather than drifting.
const PLAY_PULSE_PERIOD = 4 // 2s growing + 2s shrinking
const PLAY_BUTTON_PULSE_MAX_SCALE = 1.2

// Same easeOutBack/easeInBack pair as the toasts, one per leg (growing/shrinking).
function getPlayScalePulse(): number {
  const cyclePos = (elapsedTime % PLAY_PULSE_PERIOD) / PLAY_PULSE_PERIOD // 0..1 over the full period
  if (cyclePos <= 0.5) {
    return easeOutBack(cyclePos / 0.5) // 0..1 growing leg
  }
  return 1 - easeInBack((cyclePos - 0.5) / 0.5) // 0..1 shrinking leg, inverted to read as 1..0
}

// Ease-in-out sine (0..1..0) - smoothly accelerates/decelerates through both extremes, no overshoot.
function getPlayOpacityPulse(): number {
  return (1 - Math.cos((elapsedTime / PLAY_PULSE_PERIOD) * Math.PI * 2)) / 2
}

function getPlayButtonPulseScale(): number {
  return 1 + getPlayScalePulse() * (PLAY_BUTTON_PULSE_MAX_SCALE - 1)
}

function getPlayGlowOpacity(): number {
  return PLAY_GLOW_MIN_OPACITY + getPlayOpacityPulse() * (PLAY_GLOW_MAX_OPACITY - PLAY_GLOW_MIN_OPACITY)
}

function getPlayButtonHeightPx(): number {
  return isMobile() ? PLAY_BUTTON_HEIGHT_PX * PLAY_BUTTON_MOBILE_SCALE : PLAY_BUTTON_HEIGHT_PX
}

const PLAY_BUTTON_BOTTOM_PERCENT_MOBILE = 8
const PLAY_BUTTON_BOTTOM_PERCENT_DESKTOP = 8

function getPlayButtonBottomPercent(): `${number}%` {
  return `${isMobile() ? PLAY_BUTTON_BOTTOM_PERCENT_MOBILE : PLAY_BUTTON_BOTTOM_PERCENT_DESKTOP}%`
}

// Centers the button horizontally within the body (which has no left/right padding of its own,
// so its content width is exactly canvas_main's width) - computed in raw px, matching the button's
// own raw-px size, rather than a '%' left inset that would drift once the size became mobile-aware.
function getPlayButtonLeftPx(): number {
  return (getCanvasMainWidthPx() - getPlayButtonWidthPx()) / 2
}

// Win-sequence toast (Board complete / Find the monster / Monster collected): slides up from
// below to rest at the Play button's own bottom%, then - later, on hideToast() - slides back down.
// Position is animated purely in '%' (matching getPlayButtonBottomPercent()'s own unit) so the
// interpolation never mixes with a raw-px size, the mixing bug this file has hit before.
const TOAST_OFFSCREEN_BOTTOM_PERCENT = -55
const TOAST_ENTER_DURATION = 0.4 // seconds - quick slide up
const TOAST_EXIT_DURATION = 0.25 // seconds - quick slide down
// Raw px (1920x1080 virtual reference) lift above the resting bottom%, so the toasts sit higher
// than the Play button rather than exactly on top of it.
const TOAST_LIFT_PX = 100

// easeOutBack: fast entrance that overshoots past 1 before settling - see easings.net. c1 controls
// how big the overshoot is (1.70158 is the "standard" amount; bumped up for a punchier bounce).
function easeOutBack(t: number): number {
  const c1 = 3.2
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

// easeInBack: mirrors easeOutBack's overshoot but at the start instead of the end - dips backward
// (here: up, since exiting means animating toward a "smaller" bottom%) before rushing to 1, i.e. a
// small anticipation rise before the fast drop.
function easeInBack(t: number): number {
  const c1 = 3.2
  const c3 = c1 + 1
  return c3 * t * t * t - c1 * t * t
}

function getToastBottomPercent(): number {
  const restPercent = isMobile() ? PLAY_BUTTON_BOTTOM_PERCENT_MOBILE : PLAY_BUTTON_BOTTOM_PERCENT_DESKTOP
  if (toastExitStartedAt !== null) {
    const t = Math.min(1, (elapsedTime - toastExitStartedAt) / TOAST_EXIT_DURATION)
    return restPercent + (TOAST_OFFSCREEN_BOTTOM_PERCENT - restPercent) * easeInBack(t)
  }
  const t = Math.min(1, (elapsedTime - (toastPhaseStartedAt ?? elapsedTime)) / TOAST_ENTER_DURATION)
  return TOAST_OFFSCREEN_BOTTOM_PERCENT + (restPercent - TOAST_OFFSCREEN_BOTTOM_PERCENT) * easeOutBack(t)
}

// Swaps in a new toast phase and (re)starts its entrance animation.
function showToast(phase: 'boardComplete' | 'findMonster' | 'monsterCollected' | 'monsterNotCollected') {
  toastPhase = phase
  toastPhaseStartedAt = elapsedTime
  toastExitStartedAt = null
  toastExitCallback = null
}

// Starts the current toast's exit animation; `after` runs once it finishes (see the system loop),
// right when toastPhase is cleared. If nothing is showing, `after` runs immediately.
function hideToast(after: () => void) {
  if (toastPhase === null) {
    after()
    return
  }
  toastExitStartedAt = elapsedTime
  toastExitCallback = after
}

function resetToastState() {
  toastPhase = null
  toastPhaseStartedAt = null
  toastExitStartedAt = null
  toastExitCallback = null
  toastShakeStartedAt = null
}

// "Missed" shake on the find-the-monster toast (see handlePrizeMissed): a decaying horizontal
// wobble applied as a margin offset on the toast box, independent of its enter/exit slide above.
const TOAST_SHAKE_DURATION = 0.4 // seconds
const TOAST_SHAKE_MAGNITUDE_PX = 40
const TOAST_SHAKE_OSCILLATIONS = 4 // full left-right cycles over TOAST_SHAKE_DURATION

function triggerToastShake() {
  toastShakeStartedAt = elapsedTime
}

function getToastShakeOffsetPx(): number {
  if (toastShakeStartedAt === null) return 0
  const t = elapsedTime - toastShakeStartedAt
  if (t >= TOAST_SHAKE_DURATION) return 0
  const decay = 1 - t / TOAST_SHAKE_DURATION
  return Math.sin(t * TOAST_SHAKE_OSCILLATIONS * Math.PI * 2) * TOAST_SHAKE_MAGNITUDE_PX * decay
}

const BASE_POINTS_PER_PAIR = 5
const TIME_BONUS_MAX = 10
const ERROR_PENALTY = 0.5

// Seconds the "Time's up" screen stays up before the board closes on its own.
const END_SCREEN_DURATION = 3
// Seconds each win-sequence toast stays up before auto-advancing (see showToast()/hideToast()).
const BOARD_COMPLETE_STAY_DURATION = 4
const MONSTER_COLLECTED_STAY_DURATION = 6

// "MATCH!" popup: seconds it takes to float up and fade out, and how far (in px) it travels.
const MATCH_ANIM_DURATION = 0.7
const MATCH_FADE_IN_END = 0.1
const MATCH_FADE_OUT_START = 0.6
const MATCH_ANIM_DISTANCE = 60

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
// canvas-sidebar is 25% of the 1920px virtual width; the box's own left/right padding (20px each,
// see below) eats into that before text wrapping should kick in.
const NOTIFICATION_TEXT_MAX_WIDTH_PX = 1920 * 0.25 - 40


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

// Loading spinner: A1-D4 as ONE combined 4x4 block of alphas.png (same span the old
// ALPHAS_COLLECTED_UVS used), spun by rotating its 4 UV corners around their own center each
// frame - UiTransform has no rotate prop, but a quad's UV sampling can still be rotated
// independently of its (fixed) screen position, which reads as the image itself spinning in place.
// Unverified in the Explorer: rotated (non-axis-aligned) UV corners are standard for textured
// quads, but this codebase has only ever fed PBUiBackground axis-aligned rectangles until now.
const SPINNER_BASE_UVS = getUvsForBlock(0, 0, 4, 4, ALPHAS_GRID)
const SPINNER_DEGREES_PER_SECOND = 90
// Base unit for the spinner behind the Monster Collected toast's icon - box is 3x this, spinner
// itself is rendered at 4.5x (bigger than its box, so it overflows symmetrically behind the icon).
const SPINNER_SIZE_PX = 80

function rotateUvsAroundCenter(uvs: number[], angleDeg: number): number[] {
  const angleRad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const centerU = (uvs[0] + uvs[4]) / 2
  const centerV = (uvs[1] + uvs[3]) / 2
  const rotated: number[] = []
  for (let i = 0; i < uvs.length; i += 2) {
    const u = uvs[i] - centerU
    const v = uvs[i + 1] - centerV
    rotated.push(centerU + u * cos - v * sin, centerV + u * sin + v * cos)
  }
  return rotated
}

function getSpinnerUvs(): number[] {
  const angle = (elapsedTime * SPINNER_DEGREES_PER_SECOND) % 360
  return rotateUvsAroundCenter(SPINNER_BASE_UVS, angle)
}

// heightPx defaults to widthPx (square/circular); pass a smaller value to squash it - the UV
// rotation math doesn't care about the element's own aspect ratio, it just spins elliptically.
function renderSpinner(widthPx: number, heightPx: number = widthPx) {
  return (
    <UiEntity
      uiTransform={{ width: widthPx, height: heightPx, flexShrink: 0 }}
      uiBackground={{ textureMode: 'stretch', texture: { src: ALPHAS_IMAGE }, uvs: getSpinnerUvs() }}
    />
  )
}

// Card back art now spans a 2x2 block of atlas_01.png: A1, A2, B1, B2
const BACK_UVS = getUvsForBlock(0, 0, 2, 2, BACK_ATLAS_GRID)

// Header button icons are 2x2 blocks of atlas_01.png.
const LEADERBOARD_BUTTON_UVS = getUvsForBlock(0, 4, 2, 2, BACK_ATLAS_GRID) // A5-B6
const CODEX_BUTTON_UVS = getUvsForBlock(0, 2, 2, 2, BACK_ATLAS_GRID) // A3-B4
const CHECKPOINTS_BUTTON_UVS = getUvsForBlock(2, 4, 2, 2, BACK_ATLAS_GRID) // C5-D6
const SCORE_BACKGROUND_UVS = getUvsForBlock(2, 0, 4, 2, BACK_ATLAS_GRID) // C1-F2
const PLAY_BUTTON_UVS = getUvsForBlock(2, 2, 4, 2, BACK_ATLAS_GRID) // C3-F4
const PLAY_GLOW_UVS = getUvsForBlock(0, 6, 4, 2, BACK_ATLAS_GRID) // A7-D8 - same 4x2 span as the button
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
  address: string
}

let leaderboard: LeaderboardEntry[] = []

let screen: Screen = 'hidden'
// Set to 'board' when checkpointSelect/inventory/leaderboard is opened while a board is in
// progress, so closing it resumes that board instead of stranding it on 'hidden' (the timer
// already pauses on its own since it only ticks while screen === 'board').
let previousScreen: Screen | null = null
let currentCheckpoint = 1
let currentBoardIndex = 0 // 0-based index into the current checkpoint's boards array
// Synced from the server on connect via 'requestProgress'/'progressUpdate', and updated locally
// (then re-synced) whenever a checkpoint is completed - see reportBoardTime below.
let highestUnlockedCheckpoint = DEBUG_UNLOCK_ALL_CHECKPOINTS ? TOTAL_CHECKPOINTS : 1
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
// TEST: same idea as the vw-derived values above (cell width also converted, not just row
// height/lock icon - a '%' cell width next to a raw-px row height would reintroduce the same
// square-vs-container mismatch fixed for score/timer), but computed as a function instead of a
// static constant: the frame's own padding (getFramePaddingPx(), mobile vs desktop) eats into
// canvas_main's width before the grid ever sees it, so the available width has to subtract that
// first - the old 'vw' formula never did, which is what caused the grid to overflow the frame.
function getCheckpointSelectCellWidthPx(): number {
  const availableWidth = getCanvasMainWidthPx() - 2 * getFramePaddingPx()
  return (availableWidth * 0.9) / CHECKPOINT_SELECT_COLS
}

function getCheckpointSelectRowHeightPx(): number {
  return getCheckpointSelectCellWidthPx() * CHECKPOINT_SELECT_BUTTON_ASPECT
}

function getCheckpointSelectLockIconSizePx(): number {
  return getCheckpointSelectCellWidthPx() * 0.6
}

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

// TEST: same idea as the vw-derived approach above (every icon in a group ends up the same
// on-screen width, (frame content width * 0.95) / groupRowSize), but as raw px so the icon's
// width AND height both come from the same virtual-canvas-scaled system - a '%' width (the old
// per-icon `${100/rowSize}%`) next to a 'vw' height is exactly the mismatch fixed for score/timer,
// since 'vw' assumed canvas_main's real width still equals CANVAS_MAIN_WIDTH_FRACTION of the true
// screen, which stopped holding once canvas_main got anchored in raw px (see CANVAS_MAIN_WIDTH_PX).
// A rarity block's own width is now just rarity.rowSize * this icon size - no % chain needed.
const CODEX_ICON_HEIGHT_TO_WIDTH_RATIO = 1.25
// Hard cap on icon width (so icon height, at the 1.25 ratio, never exceeds ~100px) - the 3 rows
// (Common/Rare/Exotic+Epic) plus their labels and the screen's own title/padding add up to more
// than the available body height on some aspect ratios (mobile in particular: canvas_main's
// height stays real/unscaled while every icon size here is virtual-scaled off width, so the two
// have no fixed relationship - width-based sizing alone can't guarantee it fits vertically).
const CODEX_MAX_ICON_SIZE_PX = 80
function getCodexIconSizePx(groupRowSize: number): number {
  const availableWidth = getCanvasMainWidthPx() - 2 * getFramePaddingPx()
  return Math.min((availableWidth * 0.95) / groupRowSize, CODEX_MAX_ICON_SIZE_PX)
}

// 1x -> 1.15x -> 1x breathing pulse for the Monster Collected toast's icon only (1s each leg, 2s
// full cycle) - same triangle-wave technique as getTimerColor/getPausedBlinkColor above.
// UiTransform has no scale prop, so this is applied via the icon's own width/height (see
// renderMonsterIcon) rather than a real transform.
const MONSTER_PULSE_PERIOD = 2
const MONSTER_PULSE_MAX_SCALE = 1.15

function getMonsterPulseScale(): number {
  const phase = ((elapsedTime % MONSTER_PULSE_PERIOD) / MONSTER_PULSE_PERIOD) * 2 // 0..2
  const triangle = phase <= 1 ? phase : 2 - phase // 0..1..0
  return 1 + triangle * (MONSTER_PULSE_MAX_SCALE - 1)
}

// A monster's prize-sheet icon at a given slot, sized by width - height is derived from the
// collection's own grid aspect (cols/rows) so non-square sheets don't squash the art. Used by the
// win-sequence toasts (find-the-monster / monster-collected).
function renderMonsterIcon(slot: number, widthPx: number) {
  const collection = getCollectionForSlot(slot)
  const heightPx = widthPx * (collection.prizeGridCols / collection.prizeGridRows)
  return (
    <UiEntity
      uiTransform={{ width: widthPx, height: heightPx, flexShrink: 0 }}
      uiBackground={{
        textureMode: 'stretch',
        texture: { src: collection.prizeImage },
        uvs: getUvsForPrizeQuadrant(slot - collection.start, collection.prizeGridCols, collection.prizeGridRows)
      }}
    />
  )
}

// Renders one rarity's label ("Common 3/8") and its badge row(s).
// iconSizePx is the icon's width (and, scaled by CODEX_ICON_HEIGHT_TO_WIDTH_RATIO, its height) in
// raw px - see getCodexIconSizePx(). The block's own width is just rowSize * iconSizePx (its
// row of icons, back to back), no '%' chain needed since every size here comes from the same
// virtual-canvas-scaled reference.
function renderRarityBlock(rarity: RarityConfig, iconSizePx: number, marginRightPx: number = 0) {
  const { collected, total } = getRarityProgress(rarity)
  const rowSize = rarity.rowSize
  const rows = Math.ceil(total / rowSize)
  const slots = Array.from({ length: total }, (_, i) => rarity.start + i)
  const collection = rarity.collection
  const iconHeight = iconSizePx * CODEX_ICON_HEIGHT_TO_WIDTH_RATIO
  return (
    <UiEntity
      key={rarity.label}
      uiTransform={{ width: rowSize * iconSizePx, flexDirection: 'column', alignItems: 'flex-start', margin: { right: marginRightPx } }}
    >
      <BitmapText text={`${rarity.label} ${collected}/${total}`} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE_BROWN} fontSize={24} uiTransform={{ margin: { top: 22, bottom: 0 } }} />
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
                  width: iconSizePx,
                  minWidth: iconSizePx,
                  height: iconHeight,
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: 0
                }}
                uiBackground={
                  slot < TOTAL_CHECKPOINTS
                    ? {
                        textureMode: 'stretch',
                        texture: { src: collectedSlot ? collection.prizeImage : collection.prizeImageLocked },
                        uvs: getUvsForPrizeQuadrant(slot - collection.start, collection.prizeGridCols, collection.prizeGridRows)
                      }
                    : { color: Color4.create(0, 0, 0, 0.5) }
                }
              >
                {collectedSlot && collectionCounts[slot] > 0 && (
                  <UiEntity
                    uiTransform={{
                      positionType: 'absolute',
                      position: { bottom: -20, right: 0 },
                      width: '100%',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    <UiEntity uiTransform={{ padding: { top: 0, bottom: 2, left: 2, right: 0 }}} uiBackground={{ color: Color4.fromHexString('#00692c59') }}>
                      {/* Label has no intrinsic size in DCL (text isn't measured for layout), so
                      without an explicit width/height it renders inside an oversized default box.
                      Width is sized off the string length (no true text measurement available) to
                      track "x2" vs "x10" instead of leaving slack around longer counts. */}
                      <Label
                        value={`x${collectionCounts[slot]}`}
                        fontSize={14}
                        color={Color4.White()}
                        textAlign="middle-center"
                        textWrap="nowrap"
                        uiTransform={{ width: `x${collectionCounts[slot]}`.length * 9, height: 16 }}
                      />
                    </UiEntity>
                  </UiEntity>
                )}
              </UiEntity>
            )
          })}
        </UiEntity>
      ))}
    </UiEntity>
  )
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
let wonMonsterQuadrant = 0
let errors = 0
let score = 0
let totalScore = 0
// Drives the gameOver ("Time's up") auto-close only - the win sequence's own timing lives in the
// toast state below.
let endScreenShownAt: number | null = null

// Bottom "toast" for the win sequence (Board complete -> Find the monster -> Monster collected/Not
// collected - see showToast()/hideToast()/getToastBottomPercent()). null means fully hidden.
type ToastPhase = 'boardComplete' | 'findMonster' | 'monsterCollected' | 'monsterNotCollected' | null
let toastPhase: ToastPhase = null
// When the current phase's entrance animation started (also doubles as its "how long has it been
// showing" clock for the auto-advance timers below).
let toastPhaseStartedAt: number | null = null
// Set the moment a hideToast() is requested; once its exit animation finishes, toastExitCallback
// runs and toastPhase is cleared - see the system loop.
let toastExitStartedAt: number | null = null
let toastExitCallback: (() => void) | null = null
// Set on a missed hop (see triggerToastShake()); decays back to null-effect after TOAST_SHAKE_DURATION.
let toastShakeStartedAt: number | null = null

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
        const boardsInCheckpoint = CHECKPOINTS[currentCheckpoint - 1].boards.length
        checkpointComplete = currentBoardIndex === boardsInCheckpoint - 1
        room.send('reportBoardTime', {
          checkpoint: currentCheckpoint,
          boardIndex: currentBoardIndex,
          timeSeconds: lastBoardTime
        })

        // Collection/unlock is granted on the physical catch (handlePrizeCaught), not here - just
        // remember which monster is up for grabs so the chase can say which one to look for.
        if (checkpointComplete) {
          wonMonsterQuadrant = currentCheckpoint - 1
        }
        showToast('boardComplete')
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
let tickingEntity: Entity
let loseAChanceEntity: Entity

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

function playTickingSound() {
  AudioSource.getMutable(tickingEntity).playing = true
}

function stopTickingSound() {
  AudioSource.getMutable(tickingEntity).playing = false
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

function playLoseAChanceSound() {
  AudioSource.playSound(loseAChanceEntity, LOSE_A_CHANCE_CLIP, true)
}

// The server's leaderboard entry is the player's real running total (reportScore accumulates into
// it and it's persisted per wallet), so adopt it every time the leaderboard arrives - including the
// requestLeaderboard on scene load. Without this, totalScore is a purely local counter that starts
// at 0 on every reload. The local `totalScore += score` on a board win stays for instant feedback;
// this reconciles it once the server echoes back.
function adoptLeaderboardScore() {
  const address = getPlayer()?.userId
  if (!address) return
  const mine = leaderboard.find((entry) => entry.address.toLowerCase() === address.toLowerCase())
  if (mine) totalScore = mine.score
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
  AudioSource.create(ambientMusicEntity, { audioClipUrl: AMBIENT_MUSIC_CLIP, playing: true, loop: true, volume: 1, global: true })

  boardMusicEntity = engine.addEntity()
  Transform.create(boardMusicEntity)
  AudioSource.create(boardMusicEntity, { audioClipUrl: BOARD_MUSIC_CLIP, playing: false, loop: true, volume: 1, global: true })

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
  AudioSource.create(countdownEntity, { audioClipUrl: COUNTDOWN_CLIP, playing: false, loop: false, volume: 0.5, global: true })

  failEntity = engine.addEntity()
  Transform.create(failEntity)
  AudioSource.create(failEntity, { audioClipUrl: FAIL_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  timeoutEntity = engine.addEntity()
  Transform.create(timeoutEntity)
  AudioSource.create(timeoutEntity, { audioClipUrl: TIMEOUT_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  tickingEntity = engine.addEntity()
  Transform.create(tickingEntity)
  AudioSource.create(tickingEntity, { audioClipUrl: TICKING_CLIP, playing: false, loop: true, volume: 0.6, global: true })

  loseAChanceEntity = engine.addEntity()
  Transform.create(loseAChanceEntity)
  AudioSource.create(loseAChanceEntity, { audioClipUrl: LOSE_A_CHANCE_CLIP, playing: false, loop: false, volume: 0.8, global: true })

  setupCelebrationCamera()

  room.onMessage('leaderboardUpdate', (data) => guard('leaderboardUpdate', () => {
    leaderboard = data.entries
    prefetchLeaderboardFaces(leaderboard.map((entry) => entry.address))
    adoptLeaderboardScore()
  }))
  room.send('requestLeaderboard', {})

  room.onMessage('serverTick', (data) => guard('serverTick', () => {
    lastServerTick = data.tick
    lastServerTickAt = elapsedTime
  }))

  room.onMessage('personalBestUpdate', (data) => guard('personalBestUpdate', () => {
    personalBests[bestTimeKey(data.checkpoint, data.boardIndex)] = data.bestTimeSeconds
  }))

  room.onMessage('progressUpdate', (data) => guard('progressUpdate', () => {
    if (!DEBUG_UNLOCK_ALL_CHECKPOINTS) highestUnlockedCheckpoint = data.highestUnlockedCheckpoint
    for (let i = 0; i < TOTAL_CHECKPOINTS; i++) {
      collectedMonsters[i] = data.collectedMonsters[i] ?? false
      collectionCounts[i] = data.collectionCounts[i] ?? 0
    }
  }))
  room.send('requestProgress', {})

  if (DEBUG_DUMP_BEST_TIMES) {
    room.onMessage('allBestTimesUpdate', (data) => {
      const parsed = data.entries
        .map((entry) => {
          const match = entry.key.match(/^bestTime-(\d+)-(\d+)$/)
          if (!match) return null
          return { checkpoint: Number(match[1]), boardIndex: Number(match[2]), seconds: entry.seconds }
        })
        .filter((e): e is { checkpoint: number; boardIndex: number; seconds: number } => e !== null)
        .sort((a, b) => a.checkpoint - b.checkpoint || a.boardIndex - b.boardIndex)
      console.log(
        `[DEBUG_DUMP_BEST_TIMES] ${parsed.length} recorded times:\n` +
          parsed.map((e) => `Checkpoint ${e.checkpoint} Board ${e.boardIndex + 1}: ${e.seconds.toFixed(1)}s`).join('\n')
      )
    })
    room.send('requestAllBestTimes', {})
  }

  // TEST: virtualWidth/virtualHeight lets the renderer scale raw-px sizes to fit any real screen,
  // per the build-ui skill. Trying it out on the R header icons first (see HEADER_RIGHT_ICON_SIZE_PX)
  // before migrating the rest of the manual vw/vh sizing done elsewhere in this file.
  ReactEcsRenderer.setUiRenderer(MemoryMatchUi, { virtualWidth: 1920, virtualHeight: 1080 })
  const tick = (dt: number) => {
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

    if (toastPhase === 'findMonster') {
      updatePrizeChase(dt)
      timeRemaining = getPrizeChaseSecondsRemaining()
    }

    // gameOver ("Time's up") auto-close - endScreenShownAt is only ever set by that path now, the
    // win sequence's own timing runs entirely on the toast state below.
    if (endScreenShownAt !== null && elapsedTime - endScreenShownAt >= END_SCREEN_DURATION) {
      screen = 'checkpointSelect'
      playAmbientMusic()
      won = false
      gameOver = false
      checkpointComplete = false
      endScreenShownAt = null
    }

    if (toastExitStartedAt !== null && elapsedTime - toastExitStartedAt >= TOAST_EXIT_DURATION) {
      const afterHide = toastExitCallback
      resetToastState()
      afterHide?.()
    }

    if (
      toastPhase === 'boardComplete' &&
      toastExitStartedAt === null &&
      toastPhaseStartedAt !== null &&
      elapsedTime - toastPhaseStartedAt >= BOARD_COMPLETE_STAY_DURATION
    ) {
      if (checkpointComplete) {
        // Hands off from the "Board complete!" toast to the in-world chase.
        hideToast(() => {
          stopBoardMusic()
          playTickingSound()
          const wonCollection = getCollectionForSlot(wonMonsterQuadrant)
          startPrizeChase(
            {
              image: wonCollection.prizeImage,
              gridCols: wonCollection.prizeGridCols,
              gridRows: wonCollection.prizeGridRows,
              localIndex: wonMonsterQuadrant - wonCollection.start
            },
            handlePrizeCaught,
            handlePrizeChaseFailed,
            handlePrizeMissed
          )
          showToast('findMonster')
        })
      } else {
        hideToast(() => startBoard(currentCheckpoint, currentBoardIndex + 1))
      }
    }

    if (
      toastPhase === 'monsterCollected' &&
      toastExitStartedAt === null &&
      toastPhaseStartedAt !== null &&
      elapsedTime - toastPhaseStartedAt >= MONSTER_COLLECTED_STAY_DURATION
    ) {
      hideToast(() => resetToIdleAfterChase('inventory'))
    }

    if (
      toastPhase === 'monsterNotCollected' &&
      toastExitStartedAt === null &&
      toastPhaseStartedAt !== null &&
      elapsedTime - toastPhaseStartedAt >= MONSTER_COLLECTED_STAY_DURATION
    ) {
      hideToast(() => resetToIdleAfterChase())
    }

    notificationTimer += dt
    if (notificationTimer >= NOTIFICATION_INTERVAL) {
      notificationTimer = 0
      currentNotification = NOTIFICATION_MESSAGES[Math.floor(Math.random() * NOTIFICATION_MESSAGES.length)]
    } else if (currentNotification !== null && notificationTimer >= NOTIFICATION_VISIBLE_DURATION) {
      currentNotification = null
    }
  }
  engine.addSystem((dt: number) => guard('uiSystem', () => tick(dt)))
}

export function showCheckpointSelect() {
  if (screen === 'board') previousScreen = 'board'
  screen = 'checkpointSelect'
}

// Chase succeeded: grant the collection (mirrors what reportBoardTime's checkpointComplete used
// to do client-side, now deferred until the player actually catches the prize), hand off from the
// "find the monster" toast to "monster collected", and let the player start another round once
// that toast's own timer closes it (see the system loop).
function handlePrizeCaught() {
  collectedMonsters[currentCheckpoint - 1] = true
  collectionCounts[currentCheckpoint - 1]++
  if (currentCheckpoint === highestUnlockedCheckpoint && highestUnlockedCheckpoint < TOTAL_CHECKPOINTS) {
    highestUnlockedCheckpoint++
  }
  room.send('reportMonsterCaught', { checkpoint: currentCheckpoint })
  stopTickingSound()
  playPrizeSound()
  // Was 180 (the sweep's opposite half) so it picked up where the board-win orbit (0deg->180deg)
  // left off - but the catch now happens much later, disconnected from that shot, and 180deg
  // showed the player's back instead of their front. Same start as the board-win orbit fixes it.
  triggerCelebrationCamera('fistpump', 0)
  hideToast(() => showToast('monsterCollected'))
}

// Chase failed (ran out of attempts): no collection is granted - the player can replay the
// checkpoint's boards to try catching the monster again.
function handlePrizeChaseFailed() {
  stopTickingSound()
  playTimeoutSound()
  hideToast(() => showToast('monsterNotCollected'))
}

// A hop timed out and the prize moved to a new spot without being caught: shake the "find the
// monster" toast and play a dedicated sound for it (distinct from the board-match fail sound).
function handlePrizeMissed() {
  playLoseAChanceSound()
  triggerToastShake()
}

function resetToIdleAfterChase(nextScreen: Screen = 'hidden') {
  screen = nextScreen
  playAmbientMusic()
  won = false
  gameOver = false
  checkpointComplete = false
  endScreenShownAt = null
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
  stopPrizeChase()
  stopTickingSound()
  resetToastState()
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
  stopPrizeChase()
  stopTickingSound()
  resetToastState()
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
    {/* TEMP (crash diagnosis): see errorTrap.ts. Plain Label on purpose - the sprite font would be
        one more thing that could fail while we're trying to read why something else failed. */}
    {getCapturedError() !== null && (
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          // No width: the box shrinks to fit the text so the black plate hugs it instead of
          // banding across the screen. maxWidth still wraps a stack trace that runs long.
          maxWidth: '90%',
          alignSelf: 'flex-start',
          padding: 16
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, 0.85) }}
      >
        <Label value={getCapturedError() ?? ''} fontSize={18} color={Color4.Red()} textAlign="top-left" />
      </UiEntity>
    )}
    {/* canvas_main: the safe-area column. Reserves 8% top/bottom for the system bar and stays
        within the 30%-75% horizontal safe zone (40% wide, centered). Reuse this for all scene UI;
        a sibling "canvas-sidebar" can be added later for anything that belongs outside this column. */}
    <UiEntity
      uiTransform={{
        width: getCanvasMainWidthPx(),
        // Stays '100%' (real, unscaled) rather than a raw-px 1080 - height isn't part of the
        // reported bug, and a raw px height would letterbox (stop filling the real screen height)
        // whenever width - not height - ends up being the scale factor's constraining axis
        // (the common case: any portrait/narrower-than-16:9 screen).
        height: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: { top: CANVAS_MAIN_PADDING_PX, bottom: CANVAS_MAIN_PADDING_PX },
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
              padding: { left: HEADER_LEFT_BOX_PADDING_PX, right: HEADER_LEFT_BOX_PADDING_PX },
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: DEBUG_BORDER_WHITE
            }}
          >
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}
              uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_BACKGROUND_UVS }}
            />
            <UiEntity uiTransform={{ width: STAT_ICON_SIZE_PX, height: STAT_ICON_SIZE_PX, flexShrink: 0 }} uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_ICON_UVS }} />
            <UiEntity uiTransform={{ flexGrow: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center' }}>
              <BitmapText
                text={DEBUG_SCORE_OVERRIDE ? '99.999' : `${totalScore}`}
                font={GERM_ONE_FONT}
                image={GERM_ONE_IMAGE}
                fontSize={STAT_FONT_SIZE_PX}
                color={Color4.White()}
              />
            </UiEntity>
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
                padding: { left: HEADER_LEFT_BOX_PADDING_PX, right: HEADER_LEFT_BOX_PADDING_PX },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            >
              <UiEntity
                uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}
                uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_BACKGROUND_UVS }}
              />
              {screen === 'board' ? (
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexGrow: 1, height: '100%' }}>
                  <UiEntity uiTransform={{ width: STAT_ICON_SIZE_PX, height: STAT_ICON_SIZE_PX, flexShrink: 0 }} uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: TIMER_ICON_UVS }} />
                  <UiEntity uiTransform={{ flexGrow: 1, height: '100%', justifyContent: 'center', alignItems: 'center' }}>
                    <BitmapText text={`${Math.ceil(timeRemaining)}s`} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={STAT_FONT_SIZE_PX} color={getTimerColor()} />
                  </UiEntity>
                </UiEntity>
              ) : (
                <BitmapText
                  text="Paused"
                  font={GERM_ONE_FONT}
                  image={GERM_ONE_IMAGE}
                  fontSize={STAT_FONT_SIZE_PX}
                  color={getPausedBlinkColor()}
                  uiTransform={{ width: '100%', flexGrow: 1, height: '100%', justifyContent: 'center' }}
                  align="right"
                />
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
          padding: { top: BODY_PADDING_PX, bottom: BODY_PADDING_PX },
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
          borderColor: DEBUG_BORDER_RED
        }}
      >
        {screen === 'hidden' &&
          (() => {
            const pulseScale = getPlayButtonPulseScale()
            const pulseWidth = getPlayButtonWidthPx() * pulseScale
            const pulseHeight = getPlayButtonHeightPx() * pulseScale
            return (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  // Pinned to the bottom of the body, centered horizontally (left computed in raw
                  // px from the button's own size - see getPlayButtonLeftPx()). Fixed at the
                  // button's base position/size - just an anchor point for the pulsing group below.
                  position: { bottom: getPlayButtonBottomPercent(), left: getPlayButtonLeftPx() },
                  width: getPlayButtonWidthPx(),
                  height: getPlayButtonHeightPx()
                }}
              >
                {/* Pulsing group (button + glow together): centered on the anchor's own center via
                top/left 50% + negative margin, so it grows/shrinks in place. */}
                <UiEntity
                  uiTransform={{
                    positionType: 'absolute',
                    position: { top: '50%', left: '50%' },
                    margin: { top: -pulseHeight / 2, left: -pulseWidth / 2 },
                    width: pulseWidth,
                    height: pulseHeight,
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  {/* Glow: dedicated sprite (PLAY_GLOW_UVS), 1.4x the button's size, pulsing opacity. */}
                  <UiEntity
                    uiTransform={{
                      positionType: 'absolute',
                      position: { top: 0, left: 0 },
                      margin: {
                        top: -(pulseHeight * (PLAY_GLOW_SCALE - 1)) / 2,
                        left: -(pulseWidth * (PLAY_GLOW_SCALE - 1)) / 2
                      },
                      width: pulseWidth * PLAY_GLOW_SCALE,
                      height: pulseHeight * PLAY_GLOW_SCALE
                    }}
                    uiBackground={{
                      textureMode: 'stretch',
                      texture: { src: BACK_IMAGE },
                      uvs: PLAY_GLOW_UVS,
                      color: Color4.create(1, 1, 1, getPlayGlowOpacity())
                    }}
                  />
                  <UiEntity
                    uiTransform={{
                      positionType: 'absolute',
                      position: { top: 0, left: 0 },
                      width: '100%',
                      height: '100%',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'flex-end'
                    }}
                    uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: PLAY_BUTTON_UVS }}
                    onMouseDown={() => startCheckpoint(highestUnlockedCheckpoint)}
                  />
                </UiEntity>
              </UiEntity>
            )
          })()}

        {/* PROVISIONAL: board 1/2/3 progress, see showingBoardProgress(). */}
        {showingBoardProgress() && (
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: BOARD_PROGRESS_TOP_INSET_VH, left: 0 },
              width: '100%',
              margin: { top: '3vh' },
              justifyContent: 'center'
            }}
          >
            <UiEntity
              uiTransform={{
                width: BOARD_PROGRESS_BAR_WIDTH_PERCENT,
                height: 'auto',
                borderRadius: 20,
                padding: { left: BOARD_PROGRESS_BAR_PADDING_VH, right: BOARD_PROGRESS_BAR_PADDING_VH },
                flexDirection: 'row',
                alignItems: 'center'
              }}
              uiBackground={{ color: BOARD_PROGRESS_BAR_COLOR }}
            >
              <UiEntity uiTransform={{ width: '50%', padding: { left: 10, right: 10 }, flexDirection: 'row', justifyContent: 'center' }}>
                <BitmapText text="Board progression:" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={20} />
              </UiEntity>
              <UiEntity
                uiTransform={{
                  width: '50%',
                  padding: { left: 10, right: 10 },
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                {[0, 1, 2].map((boardIndex) => (
                  <UiEntity
                    key={boardIndex}
                    uiTransform={{
                      width: BOARD_PROGRESS_PIP_SIZE_VH,
                      height: BOARD_PROGRESS_PIP_SIZE_VH,
                      borderRadius: 999,
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    uiBackground={{ color: boardIndex === currentBoardIndex ? BOARD_PROGRESS_PIP_ACTIVE_COLOR : BOARD_PROGRESS_PIP_INACTIVE_COLOR }}
                  >
                    <BitmapText text={`${boardIndex + 1}`} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={31.5} />
                  </UiEntity>
                ))}
              </UiEntity>
            </UiEntity>
          </UiEntity>
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
                <BitmapText text={`${value}`} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={fontSize} />
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
              // Backstop for BOARD_GRID_WIDTH_FRACTION above: if some real device aspect ratio still
              // makes the grid taller than the frame's real available height, clip it instead of
              // letting cells render past the parchment art's edge.
              overflow: 'hidden',
              flexDirection: 'column',
              alignItems: 'center',
              padding: getFramePaddingPx(),
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
                width: CLOSE_BUTTON_SIZE_PX,
                height: CLOSE_BUTTON_SIZE_PX,
                positionType: 'absolute',
                // Raw px, same reference as the button's own size - a '%'/'vh' inset paired with
                // a raw-px button size is exactly the mismatch fixed for score/timer.
                position: { top: CLOSE_BUTTON_TOP_INSET_PX, right: MUSIC_BUTTON_RIGHT_INSET_PX },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: musicMuted ? MUSIC_OFF_UVS : MUSIC_ON_UVS }}
              onMouseDown={() => toggleMusic()}
            />
            <UiEntity
              uiTransform={{
                width: CLOSE_BUTTON_SIZE_PX,
                height: CLOSE_BUTTON_SIZE_PX,
                positionType: 'absolute',
                position: { top: CLOSE_BUTTON_TOP_INSET_PX, right: CLOSE_BUTTON_INSET_PX },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeBoard()}
            />
            <BitmapText
              text={`Checkpoint ${currentCheckpoint}`}
              font={GERM_ONE_FONT}
              image={GERM_ONE_IMAGE_BROWN}
              fontSize={SCREEN_TITLE_FONT_SIZE_PX}
              uiTransform={{
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            />
            <BitmapText
              text={`Board ${currentBoardIndex + 1}/${CHECKPOINTS[currentCheckpoint - 1].boards.length}`}
              font={GERM_ONE_FONT}
              image={GERM_ONE_IMAGE_BROWN}
              fontSize={SCREEN_TITLE_FONT_SIZE_PX}
              uiTransform={{
                margin: { bottom: 4 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            />
            <BitmapText
              text={(() => {
                const best = personalBests[bestTimeKey(currentCheckpoint, currentBoardIndex)]
                return best === undefined || best === NO_BEST_TIME ? 'Best Time: --' : `Best Time: ${best.toFixed(1)}s`
              })()}
              font={GERM_ONE_FONT}
              image={GERM_ONE_IMAGE_BROWN}
              fontSize={SCREEN_SUBTITLE_FONT_SIZE_PX}
              uiTransform={{
                margin: { bottom: 12 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            />
            <UiEntity
              uiTransform={{
                width: `${BOARD_GRID_WIDTH_FRACTION * 100}%`,
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
                      height: getBoardCellSizePx(COLS),
                      flexDirection: 'row',
                      flexShrink: 0,
                      borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                      borderColor: DEBUG_BORDER_GREEN
                    }}
                  >
                    {cells.slice(rowIndex * COLS, rowIndex * COLS + COLS).map((cell, colIndex) => (
                      <UiEntity
                        key={rowIndex * COLS + colIndex}
                        uiTransform={{
                          width: getBoardCellSizePx(COLS),
                          height: getBoardCellSizePx(COLS),
                          flexShrink: 0,
                          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                          borderColor: DEBUG_BORDER_BLUE
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
              padding: getFramePaddingPx(),
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
                width: CLOSE_BUTTON_SIZE_PX,
                height: CLOSE_BUTTON_SIZE_PX,
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeCheckpointSelect()}
            />
            <BitmapText text="Select checkpoint" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE_BROWN} fontSize={SCREEN_TITLE_FONT_SIZE_PX} uiTransform={{ margin: { top: 4, bottom: 12 } }} />
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
                    height: getCheckpointSelectRowHeightPx(),
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
                          <BitmapText text={String(checkpoint).padStart(2, '0')} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE_BROWN} fontSize={35} />
                        ) : (
                          <UiEntity
                            uiTransform={{ width: getCheckpointSelectLockIconSizePx(), height: getCheckpointSelectLockIconSizePx() }}
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
              padding: getFramePaddingPx(),
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
                width: CLOSE_BUTTON_SIZE_PX,
                height: CLOSE_BUTTON_SIZE_PX,
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeInventory()}
            />
            <BitmapText
              text="Monster Codex"
              font={GERM_ONE_FONT}
              image={GERM_ONE_IMAGE_BROWN}
              fontSize={SCREEN_TITLE_FONT_SIZE_PX}
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
                const iconSizePx = getCodexIconSizePx(groupRowSize)
                return (
                  <UiEntity
                    key={group.map((r) => r.label).join('+')}
                    uiTransform={{
                      width: '100%',
                      flexDirection: 'row',
                      justifyContent: group.length > 1 ? 'space-between' : 'flex-start',
                      alignItems: 'flex-start',
                      margin: { bottom: 54 }
                    }}
                  >
                    {group.map((rarity, rarityIndex) =>
                      renderRarityBlock(rarity, iconSizePx, group.length > 1 && rarityIndex === 0 ? 21.6 : 0)
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
              padding: getFramePaddingPx(),
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
                width: CLOSE_BUTTON_SIZE_PX,
                height: CLOSE_BUTTON_SIZE_PX,
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeLeaderboard()}
            />
            <BitmapText
              text="Leaderboard"
              font={GERM_ONE_FONT}
              image={GERM_ONE_IMAGE_BROWN}
              fontSize={SCREEN_TITLE_FONT_SIZE_PX}
              uiTransform={{
                margin: { bottom: 12 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            />
            <UiEntity
              uiTransform={{
                width: '90%',
                flexDirection: 'column',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: DEBUG_BORDER_WHITE
              }}
            >
              {leaderboard.length === 0 ? (
                <BitmapText text="No scores yet" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE_BROWN} fontSize={SCREEN_SUBTITLE_FONT_SIZE_PX} uiTransform={{ width: '100%' }} align="center" />
              ) : (
                leaderboard.map((entry, index) => (
                  <UiEntity
                    key={index}
                    uiTransform={{
                      width: '100%',
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: { top: 4, bottom: 4 },
                      borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                      borderColor: DEBUG_BORDER_GREEN
                    }}
                  >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
                      <Label
                        value={`${index + 1}.`}
                        fontSize={LEADERBOARD_ROW_NAME_FONT_SIZE_PX}
                        color={SCREEN_TEXT_COLOR}
                        textAlign="middle-right"
                        textWrap="nowrap"
                        uiTransform={{
                          width: LEADERBOARD_RANK_WIDTH_PX,
                          height: LEADERBOARD_ROW_NAME_FONT_SIZE_PX * 1.3,
                          flexShrink: 0
                        }}
                      />
                      <UiEntity
                        uiTransform={{
                          width: LEADERBOARD_AVATAR_SIZE_PX,
                          height: LEADERBOARD_AVATAR_SIZE_PX,
                          flexShrink: 0,
                          borderRadius: 999,
                          margin: { right: 6 }
                        }}
                        uiBackground={{
                          textureMode: 'stretch',
                          texture: { src: getLeaderboardFaceUrl(entry.address) ?? FALLBACK_PROFILE_PIC_IMAGE },
                          uvs: [0, 0, 0, 1, 1, 1, 1, 0],
                          color: Color4.White()
                        }}
                      />
                      <Label
                        value={entry.playerName}
                        fontSize={LEADERBOARD_ROW_NAME_FONT_SIZE_PX}
                        color={SCREEN_TEXT_COLOR}
                        textWrap="nowrap"
                        textAlign="middle-left"
                        uiTransform={{
                          width: 'auto',
                          height: LEADERBOARD_ROW_NAME_FONT_SIZE_PX * 1.3,
                          flexShrink: 0,
                          overflow: 'hidden'
                        }}
                      />
                    </UiEntity>
                    <BitmapText
                      text={`${entry.score}`}
                      font={GERM_ONE_FONT}
                      image={GERM_ONE_IMAGE_BROWN}
                      fontSize={LEADERBOARD_ROW_SCORE_FONT_SIZE_PX}
                    />
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
          minHeight: isMobile() ? FOOTER_MIN_HEIGHT_MOBILE_PX : FOOTER_MIN_HEIGHT_DESKTOP_PX,
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
                position: { bottom: 4, right: 4 },
                padding: { top: 2, bottom: 2, left: 4, right: 4 }
              }}
              uiBackground={{ color: Color4.create(0, 0, 0, 0.5) }}
            >
              <Label
                value={serverOnline ? `Server online (tick ${lastServerTick})` : 'Server offline'}
                fontSize={isMobile() ? 18 : 12}
                color={serverOnline ? Color4.create(0.2, 0.7, 0.3, 1) : Color4.create(0.9, 0.3, 0.3, 1)}
              />
            </UiEntity>
          )
        })()}
        {DEBUG_CANVAS_INFO &&
          (() => {
            const canvasInfo = UiCanvasInformation.getOrNull(engine.RootEntity)
            return (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { bottom: 4, left: 4 },
                  padding: { top: 2, bottom: 2, left: 4, right: 4 }
                }}
                uiBackground={{ color: Color4.create(0, 0, 0, 0.5) }}
              >
                <Label
                  value={
                    canvasInfo
                      ? `canvas ${canvasInfo.width.toFixed(0)}x${canvasInfo.height.toFixed(0)} dpr=${canvasInfo.devicePixelRatio.toFixed(2)} mobile=${isMobile()}`
                      : 'canvas: null'
                  }
                  fontSize={isMobile() ? 18 : 12}
                  color={Color4.Yellow()}
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
              // Same placeholder background as the win-sequence toasts (see the toast's own
              // uiBackground below) - solid black at 85% opacity, until there's dedicated frame art.
              uiBackground={{ color: Color4.create(0, 0, 0, 0.85) }}
            >
              <BitmapText
                text={currentNotification}
                font={GERM_ONE_FONT}
                image={GERM_ONE_IMAGE}
                fontSize={24}
                uiTransform={{ width: '100%' }}
                align="center"
                maxWidth={NOTIFICATION_TEXT_MAX_WIDTH_PX}
              />
            </UiEntity>
          )
        })()}
    </UiEntity>

    {gameOver && !won && (
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
        <BitmapText text="Time's up" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={36} />
      </UiEntity>
    )}

    {/* Spinner + pulsing monster icon, centered on screen - separate from the bottom toast so it
    reads as "the reward", while the toast box below just carries the "Monster Collected!" text.
    Visible for exactly as long as the toast phase is (including its slide in/out window). */}
    {toastPhase === 'monsterCollected' && (
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: '50%', left: '50%' },
          margin: { top: -(SPINNER_SIZE_PX * 3) / 2, left: -(SPINNER_SIZE_PX * 3) / 2 },
          width: SPINNER_SIZE_PX * 3,
          height: SPINNER_SIZE_PX * 3,
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {/* Spinner (4.5x) is bigger than its box (3x) - overflows symmetrically behind the icon
        since the box centers it via flex, no clipping set. */}
        {renderSpinner(SPINNER_SIZE_PX * 4.5)}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, left: 0 },
            width: '100%',
            height: '100%',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {renderMonsterIcon(wonMonsterQuadrant, 192 * getMonsterPulseScale())}
        </UiEntity>
      </UiEntity>
    )}

    {toastPhase !== null && (
      <UiEntity
        uiTransform={{
          width: '100%',
          positionType: 'absolute',
          position: { bottom: `${getToastBottomPercent()}%`, left: 0 },
          // Extra lift above the animated bottom%: margin is raw px (1920x1080 virtual reference,
          // scaled by virtualWidth/virtualHeight), so it composes with the '%' position above
          // without mixing units on the same value - '%' drives the slide, this is a fixed offset
          // on top of wherever that lands.
          margin: { bottom: TOAST_LIFT_PX },
          // uiTransform defaults to flexDirection: 'row', where alignItems only centers the
          // cross axis (vertical) - justifyContent is what centers along a row's main axis.
          justifyContent: 'center'
        }}
      >
        <UiEntity
          uiTransform={{
            flexDirection: toastPhase === 'boardComplete' ? 'column' : 'row',
            alignItems: 'center',
            padding: { top: 16, bottom: 16, left: 20, right: 20 },
            borderRadius: 15,
            // Missed-hop shake (see triggerToastShake()) - a decaying left/right wobble independent
            // of the enter/exit slide on the wrapper above.
            margin: { left: getToastShakeOffsetPx() }
          }}
          // Placeholder background until the toast gets its own frame art - solid black at 85% opacity.
          uiBackground={{ color: Color4.create(0, 0, 0, 0.85) }}
        >
          {toastPhase === 'boardComplete' && (
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
              <BitmapText text="Board complete!" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={36} />
              <BitmapText text={`+${score} pts`} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={24} uiTransform={{ margin: { top: 8 } }} />
              {isNewBestTime && (
                <BitmapText
                  text={`New Best Time! ${lastBoardTime.toFixed(1)}s`}
                  font={GERM_ONE_FONT}
                  image={GERM_ONE_IMAGE}
                  fontSize={20}
                  uiTransform={{ margin: { top: 8 } }}
                />
              )}
            </UiEntity>
          )}
          {toastPhase === 'findMonster' && renderMonsterIcon(wonMonsterQuadrant, 64)}
          {toastPhase === 'findMonster' && (
            <UiEntity uiTransform={{ flexDirection: 'column', margin: { left: 16 } }}>
              <BitmapText text="Mission:" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={28} />
              <BitmapText
                text={`Collect the monster.\nChances: ${getPrizeChaseChancesRemaining()}/${PRIZE_CHASE_MAX_ATTEMPTS}`}
                font={GERM_ONE_FONT}
                image={GERM_ONE_IMAGE}
                fontSize={20}
              />
            </UiEntity>
          )}
          {toastPhase === 'monsterCollected' && (
            <BitmapText text="Monster Collected!" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={28} />
          )}
          {toastPhase === 'monsterNotCollected' && (
            <BitmapText text="Monster Not Collected" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={28} />
          )}
        </UiEntity>
      </UiEntity>
    )}
  </UiEntity>
)
