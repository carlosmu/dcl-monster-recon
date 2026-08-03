import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation, AudioSource, Transform, type Entity } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer } from '@dcl/sdk/players'
import checkpointsData from './checkpoints.json'
import { room } from './shared/messages'
import { setupCelebrationCamera, triggerCelebrationCamera, updateCelebrationCamera, triggerDefeatEmote } from './celebration'

const DEBUG_CELL_LABELS = false
const DEBUG_LAYOUT_BORDERS = false

const BACK_IMAGE = 'assets/images/atlas_01.png'
const ATLAS_02_IMAGE = 'assets/images/atlas_02.png'
const FRONT_IMAGE = 'assets/images/cards_01.png'
const PRIZE_IMAGE = 'assets/images/prizes_01.png'
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
const FRONT_GRID = 5 // cards_01.png / prizes_01.png grid
const BACK_ATLAS_GRID = 8 // atlas_01.png grid
const ALPHAS_IMAGE = 'assets/images/alphas.png'
const ALPHAS_GRID = 8 // alphas.png grid

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

// One entry per checkpoint; checkpoint N's prize quadrant is CHECKPOINTS[N - 1] / (N - 1),
// so the checkpoint order and the A1..E5 prize order stay in lockstep automatically.
const CHECKPOINTS: CheckpointConfig[] = checkpointsData
const TOTAL_CHECKPOINTS = CHECKPOINTS.length

let COLS = CHECKPOINTS[0].boards[0].cols
let ROWS = CHECKPOINTS[0].boards[0].rows
let GAME_DURATION = CHECKPOINTS[0].boards[0].duration
let FLIP_TIMEOUT = CHECKPOINTS[0].boards[0].flipTimeout
let SCORE_MULTIPLIER = CHECKPOINTS[0].boards[0].scoreMultiplier

// Board height as a fraction of the real screen height, matched to the original 400px/1080px desktop look.
// Kept as a fraction (not a raw pixel size) so mobile and desktop render the board at the same relative size.
const BOARD_HEIGHT_FRACTION = 400 / 1080
// Right-hand header icon buttons (leaderboard/codex/checkpoints): sized as large as the header
// row allows while leaving a visible margin around each square icon.
const HEADER_ICON_BUTTON_SIZE = 96
const STAT_ICON_SIZE = 64
// Both the close (X) and music toggle buttons are 50% bigger than their base 5vh size on
// desktop, 100% bigger on mobile.
let CLOSE_BUTTON_SIZE = 48 // fallback until the first canvas read
let MUSIC_BUTTON_SIZE = 48 // fallback until the first canvas read
// Body text color for the memory board, checkpoint select, codex, and leaderboard screens.
const SCREEN_TEXT_COLOR = Color4.fromHexString('#2c180b')
// Frame padding as a fraction of the real screen height, matched to a 96px/1080px desktop look.
const FRAME_PADDING_FRACTION = 96 / 1080
// Width of canvas_main (the safe-area column) as a fraction of screen width. Shared between the
// layout and the cellSize calculation so the grid never grows wider than the column it sits in.
const CANVAS_MAIN_WIDTH_FRACTION = 0.45
// Fraction of canvas_main's height left for the body once the 10vh header and its 1vh top/bottom
// padding are subtracted. Used to size the Codex grid without overflowing past the header.
const CANVAS_MAIN_BODY_HEIGHT_FRACTION = 1 - 0.1 - 0.02
// Header row's 3 columns as fractions of the header row's width: left (score/leaderboard),
// middle (timer/play), right (codex/checkpoints) - must match the uiTransform widths below.
// Header has 2 children: left (score + timer/play, left-aligned) and right (leaderboard/codex/
// checkpoints icons, right-aligned) - must match the uiTransform widths below.
const HEADER_LEFT_COLUMN_FRACTION = 0.5
// Timer/play box as a fraction of the left column's width (so, of the full header row, it's
// HEADER_MIDDLE_COLUMN_FRACTION * HEADER_LEFT_COLUMN_FRACTION).
const HEADER_MIDDLE_COLUMN_FRACTION = 0.5

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
const PRIZE_BACKDROP_SIZE = 180
const PRIZE_PULSE_PERIOD = 2 // seconds for a full 1x -> 2x -> 1x cycle
const PRIZE_PULSE_MAX_SCALE = 2

function getPrizePulseSize(): number {
  const phase = ((elapsedTime % PRIZE_PULSE_PERIOD) / PRIZE_PULSE_PERIOD) * 2 // 0..2
  const triangle = phase <= 1 ? phase : 2 - phase // 0..1..0
  const scale = 1 + triangle * (PRIZE_PULSE_MAX_SCALE - 1)
  return PRIZE_BACKDROP_SIZE * scale
}

// UiTransform has no scale/transform prop, so a horizontal flip is done by mirroring the UVs.
const PRIZE_FLIP_INTERVAL = 0.5 // seconds between horizontal flips

function mirrorUvsHorizontal(uvs: number[]): number[] {
  return [uvs[6], uvs[7], uvs[4], uvs[5], uvs[2], uvs[3], uvs[0], uvs[1]]
}

function getPrizeUvs(quadrant: number): number[] {
  const uvs = getUvsForQuadrant(quadrant)
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

let cellSize = 200 // fallback until the first canvas read
let framePadding = 32 // fallback until the first canvas read

function getUvsForBlock(col: number, row: number, colSpan: number, rowSpan: number, grid: number): number[] {
  const u1 = col / grid
  const u2 = (col + colSpan) / grid
  // v=0 is the bottom of the texture, v=1 is the top, so row 0 (A1, top row) must map to the topmost band
  const v1 = (grid - row - rowSpan) / grid
  const v2 = (grid - row) / grid
  // uvs go bottom-left, top-left, top-right, bottom-right (clockwise), per PBUiBackground
  return [u1, v1, u1, v2, u2, v2, u2, v1]
}

function getUvsForQuadrant(index: number): number[] {
  return getUvsForBlock(index % FRONT_GRID, Math.floor(index / FRONT_GRID), 1, 1, FRONT_GRID)
}

// Card back art now spans a 2x2 block of atlas_01.png: A1, A2, B1, B2
const BACK_UVS = getUvsForBlock(0, 0, 2, 2, BACK_ATLAS_GRID)

// "Monster collected!" backdrop spans a 4x4 block of alphas.png: A1 to D4
const ALPHAS_COLLECTED_UVS = getUvsForBlock(0, 0, 4, 4, ALPHAS_GRID)

// Rarity badges are 2x2 blocks of atlas_01.png: common A7-B8, rare C7-D8, exotic E7-F8, epic G7-H8
const COMMON_BADGE_UVS = getUvsForBlock(0, 6, 2, 2, BACK_ATLAS_GRID)
const RARE_BADGE_UVS = getUvsForBlock(2, 6, 2, 2, BACK_ATLAS_GRID)
const EXOTIC_BADGE_UVS = getUvsForBlock(4, 6, 2, 2, BACK_ATLAS_GRID)
const EPIC_BADGE_UVS = getUvsForBlock(6, 6, 2, 2, BACK_ATLAS_GRID)

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

// 'hidden' until the in-world Play button opens the checkpoint select screen.
type Screen = 'hidden' | 'checkpointSelect' | 'board' | 'inventory' | 'leaderboard'

interface LeaderboardEntry {
  playerName: string
  score: number
}

let leaderboard: LeaderboardEntry[] = []

let screen: Screen = 'hidden'
let currentCheckpoint = 1
let currentBoardIndex = 0 // 0-based index into the current checkpoint's boards array
// In-memory only for now — will be replaced by progress read from the authoritative server.
let highestUnlockedCheckpoint = 1
// One slot per checkpoint; true once that checkpoint's monster prize has been collected.
const collectedMonsters: boolean[] = new Array(TOTAL_CHECKPOINTS).fill(false)
// One slot per checkpoint; how many times that checkpoint's monster prize has been collected.
const collectionCounts: number[] = new Array(TOTAL_CHECKPOINTS).fill(0)
const CHECKPOINT_SELECT_COLS = FRONT_GRID
const CHECKPOINT_SELECT_ROWS = Math.ceil(TOTAL_CHECKPOINTS / CHECKPOINT_SELECT_COLS)
// Approximate height of the "Monster Codex" title above the grid.
const CODEX_HEADER_RESERVED = 60
// Approximate width of the left rarity/progress sidebar (label + margin) next to the grid.
const CODEX_SIDEBAR_WIDTH = 110

// Rarity ranges by checkpoint-select slot index (row * FRONT_GRID + col):
// common A1-B3, rare C3-E4, exotic A5-D5, epic E5.
// rowSize: how many cells per row when laying out this rarity's slots in the Codex grid.
const RARITIES = [
  { label: 'Common', start: 0, end: 11, badgeUvs: COMMON_BADGE_UVS, rowSize: 6 },
  { label: 'Rare', start: 12, end: 19, badgeUvs: RARE_BADGE_UVS, rowSize: 4 },
  { label: 'Exotic', start: 20, end: 23, badgeUvs: EXOTIC_BADGE_UVS, rowSize: 4 },
  { label: 'Epic', start: 24, end: 24, badgeUvs: EPIC_BADGE_UVS, rowSize: 1 }
]

const CODEX_COLS = Math.max(...RARITIES.map((r) => r.rowSize))
const CODEX_ROWS = RARITIES.reduce((sum, r) => sum + Math.ceil((r.end - r.start + 1) / r.rowSize), 0)

function getRarityProgress(rarity: { start: number; end: number }): { collected: number; total: number } {
  let collected = 0
  for (let slot = rarity.start; slot <= rarity.end; slot++) {
    if (slot < TOTAL_CHECKPOINTS && collectedMonsters[slot]) collected++
  }
  return { collected, total: rarity.end - rarity.start + 1 }
}

function getRarityLabel(slot: number): string {
  const rarity = RARITIES.find((r) => slot >= r.start && slot <= r.end)
  return rarity ? rarity.label : ''
}

function getRarityBadgeUvs(slot: number): number[] {
  const rarity = RARITIES.find((r) => slot >= r.start && slot <= r.end)
  return rarity ? rarity.badgeUvs : COMMON_BADGE_UVS
}
let checkpointSelectCellSize = 80 // fallback until the first canvas read
let codexCellSize = 80 // fallback until the first canvas read

let cells: CellState[] = []
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
  const pool = Array.from({ length: FRONT_GRID * FRONT_GRID }, (_, i) => i)
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

let boardMusicEntity: Entity
let boardEndEntity: Entity
let prizeEntity: Entity
let matchEntity: Entity
let countdownEntity: Entity
let failEntity: Entity
let timeoutEntity: Entity

function playBoardMusic() {
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
  } else if (screen === 'board' && !gameOver && !won && countdownStart === null) {
    playBoardMusic()
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

  ReactEcsRenderer.setUiRenderer(MemoryMatchUi)
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

      const heightCellSize = Math.floor((BOARD_HEIGHT_FRACTION * canvas.height) / ROWS)
      const availableWidth = CANVAS_MAIN_WIDTH_FRACTION * canvas.width - 2 * framePadding
      const widthCellSize = Math.floor(availableWidth / COLS)
      const baseCellSize = Math.min(heightCellSize, widthCellSize)
      const boostedCellSize = isMobile() ? Math.round(baseCellSize * 1.5) : baseCellSize
      // Re-clamp to widthCellSize: the mobile touch-size boost must never push the grid past
      // the available width again, or the nine-slice frame overflows canvas_main in X.
      cellSize = Math.min(boostedCellSize, widthCellSize)

      // Checkpoint select is always a fixed grid, independent of the current board's size.
      const selectHeightCellSize = Math.floor((BOARD_HEIGHT_FRACTION * canvas.height) / CHECKPOINT_SELECT_ROWS)
      const selectWidthCellSize = Math.floor(availableWidth / CHECKPOINT_SELECT_COLS)
      checkpointSelectCellSize = Math.min(selectHeightCellSize, selectWidthCellSize)

      // Codex fills its whole container, so size its cells off the canvas_main column's actual
      // body area (width and height), minus room for the frame padding, the title, and the left
      // rarity/progress sidebar next to the grid.
      const codexAvailableWidth = availableWidth - CODEX_SIDEBAR_WIDTH
      const codexAvailableHeight = CANVAS_MAIN_BODY_HEIGHT_FRACTION * canvas.height - 2 * framePadding - CODEX_HEADER_RESERVED
      const codexHeightCellSize = Math.floor(codexAvailableHeight / CODEX_ROWS)
      const codexWidthCellSize = Math.floor(codexAvailableWidth / CODEX_COLS)
      codexCellSize = Math.min(codexHeightCellSize, codexWidthCellSize)

      const headerVhPadding = canvas.height / 100
      const closeButtonBaseSize = 5 * headerVhPadding
      const closeButtonScale = isMobile() ? 2 : 1.5
      CLOSE_BUTTON_SIZE = Math.round(closeButtonBaseSize * closeButtonScale)
      MUSIC_BUTTON_SIZE = Math.round(closeButtonBaseSize * closeButtonScale)
    }
  })
}

export function showCheckpointSelect() {
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
  screen = 'checkpointSelect'
  gameOver = false
  won = false
  checkpointComplete = false
  showingPrize = false
  endScreenShownAt = null
  countdownStart = null
}

function closeCheckpointSelect() {
  screen = 'hidden'
}

function showInventory() {
  screen = 'inventory'
}

function closeInventory() {
  screen = 'hidden'
}

function showLeaderboard() {
  screen = 'leaderboard'
}

function closeLeaderboard() {
  screen = 'hidden'
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
        borderColor: Color4.Green()
      }}
    >
      {/* header: score+timer/play (left) | leaderboard+codex+checkpoints (right) */}
      <UiEntity
        uiTransform={{
          width: '100%',
          minHeight: '10vh',
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
          borderColor: Color4.Red()
        }}
      >
        <UiEntity
          uiTransform={{
            width: `${HEADER_LEFT_COLUMN_FRACTION * 100}%`,
            height: '100%',
            padding: '1vh',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
            borderColor: Color4.White()
          }}
        >
          <UiEntity
            uiTransform={{
              width: HEADER_ICON_BUTTON_SIZE * 2,
              height: HEADER_ICON_BUTTON_SIZE,
              flexShrink: 0,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-start',
              padding: { left: '2%' },
              borderRadius: 8
            }}
            uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_BACKGROUND_UVS }}
          >
            <UiEntity uiTransform={{ width: STAT_ICON_SIZE, height: STAT_ICON_SIZE, flexShrink: 0, margin: { left: '1vh' } }} uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_ICON_UVS }} />
            <Label value={`${totalScore}`} fontSize={26} color={Color4.White()} uiTransform={{ margin: { left: '2%' } }} />
          </UiEntity>

          <UiEntity
            uiTransform={{
              width: `${HEADER_MIDDLE_COLUMN_FRACTION * 100}%`,
              height: '100%',
              padding: '1vh',
              margin: { left: 8 },
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: Color4.White()
            }}
          >
            {screen === 'board' ? (
              <UiEntity
                uiTransform={{
                  width: HEADER_ICON_BUTTON_SIZE * 2,
                  height: HEADER_ICON_BUTTON_SIZE,
                  flexShrink: 0,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  padding: { left: '2%' },
                  borderRadius: 8
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: SCORE_BACKGROUND_UVS }}
              >
                <UiEntity uiTransform={{ width: STAT_ICON_SIZE, height: STAT_ICON_SIZE, flexShrink: 0, margin: { left: '1vh' } }} uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: TIMER_ICON_UVS }} />
                <Label value={`${Math.ceil(timeRemaining)}s`} fontSize={40} color={Color4.White()} uiTransform={{ margin: { left: '-1vh' } }} />
              </UiEntity>
            ) : (
              <UiEntity
                uiTransform={{
                  width: HEADER_ICON_BUTTON_SIZE * 2,
                  height: HEADER_ICON_BUTTON_SIZE,
                  flexShrink: 0
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: PLAY_BUTTON_UVS }}
                onMouseDown={() => showCheckpointSelect()}
              />
            )}
          </UiEntity>
        </UiEntity>

        <UiEntity
          uiTransform={{
            width: `${(1 - HEADER_LEFT_COLUMN_FRACTION) * 100}%`,
            height: '100%',
            padding: '1vh',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
            borderColor: Color4.White()
          }}
        >
          <UiEntity
            uiTransform={{ width: HEADER_ICON_BUTTON_SIZE, height: HEADER_ICON_BUTTON_SIZE, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}
            uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: LEADERBOARD_BUTTON_UVS }}
            onMouseDown={() => showLeaderboard()}
          />
          <UiEntity
            uiTransform={{ width: HEADER_ICON_BUTTON_SIZE, height: HEADER_ICON_BUTTON_SIZE, flexShrink: 0, alignItems: 'center', justifyContent: 'center', margin: { left: 8 } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: CODEX_BUTTON_UVS }}
            onMouseDown={() => showInventory()}
          />
          <UiEntity
            uiTransform={{ width: HEADER_ICON_BUTTON_SIZE, height: HEADER_ICON_BUTTON_SIZE, flexShrink: 0, alignItems: 'center', justifyContent: 'center', margin: { left: 8 } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: CHECKPOINTS_BUTTON_UVS }}
            onMouseDown={() => showCheckpointSelect()}
          />
        </UiEntity>
      </UiEntity>

      {/* body */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          padding: '2vh',
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
          borderColor: Color4.Red()
        }}
      >
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
              borderColor: Color4.Red()
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
                height: MUSIC_BUTTON_SIZE,
                positionType: 'absolute',
                position: { top: 8, right: 8 + CLOSE_BUTTON_SIZE + 8 },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: musicMuted ? MUSIC_OFF_UVS : MUSIC_ON_UVS }}
              onMouseDown={() => toggleMusic()}
            />
            <UiEntity
              uiTransform={{
                width: CLOSE_BUTTON_SIZE,
                height: CLOSE_BUTTON_SIZE,
                positionType: 'absolute',
                position: { top: 8, right: 8 },
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
                borderColor: Color4.White()
              }}
            />
            <Label
              value={(() => {
                const best = personalBests[bestTimeKey(currentCheckpoint, currentBoardIndex)]
                return best === undefined || best === NO_BEST_TIME ? 'Best Time: --' : `Best Time: ${best.toFixed(1)}s`
              })()}
              fontSize={16}
              color={SCREEN_TEXT_COLOR}
              uiTransform={{
                margin: { bottom: 12 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: Color4.White()
              }}
            />
            <UiEntity
              uiTransform={{
                width: COLS * cellSize,
                height: ROWS * cellSize,
                flexDirection: 'column',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: Color4.White()
              }}
            >
              {Array.from({ length: ROWS }, (_, rowIndex) => (
                  <UiEntity
                    key={rowIndex}
                    uiTransform={{
                      width: '100%',
                      height: cellSize,
                      flexDirection: 'row',
                      borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                      borderColor: Color4.Green()
                    }}
                  >
                    {cells.slice(rowIndex * COLS, rowIndex * COLS + COLS).map((cell, colIndex) => (
                      <UiEntity
                        key={rowIndex * COLS + colIndex}
                        uiTransform={{
                          width: cellSize,
                          height: cellSize
                        }}
                        uiBackground={
                          cell.revealed
                            ? { textureMode: 'stretch', texture: { src: FRONT_IMAGE }, uvs: getUvsForQuadrant(cell.frontQuadrant) }
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
              minHeight: '60%',
              maxHeight: '100%',
              flexDirection: 'column',
              alignItems: 'center',
              padding: { top: '3vh', bottom: framePadding, left: framePadding, right: framePadding },
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: Color4.Red()
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
                height: CLOSE_BUTTON_SIZE,
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: ATLAS_02_IMAGE }, uvs: CLOSE_BUTTON_UVS }}
              onMouseDown={() => closeCheckpointSelect()}
            />
            <Label value="Select checkpoint" fontSize={28} color={SCREEN_TEXT_COLOR} uiTransform={{ margin: { top: 4 } }} />
            <UiEntity
              uiTransform={{
                width: '90%',
                height: CHECKPOINT_SELECT_ROWS * checkpointSelectCellSize,
                flexDirection: 'column',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: Color4.White()
              }}
            >
              {Array.from({ length: CHECKPOINT_SELECT_ROWS }, (_, rowIndex) => (
                <UiEntity
                  key={rowIndex}
                  uiTransform={{
                    width: '100%',
                    height: checkpointSelectCellSize,
                    flexDirection: 'row',
                    borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                    borderColor: Color4.Green()
                  }}
                >
                  {Array.from({ length: CHECKPOINT_SELECT_COLS }, (_, colIndex) => {
                    const checkpoint = rowIndex * CHECKPOINT_SELECT_COLS + colIndex + 1
                    if (checkpoint > TOTAL_CHECKPOINTS) {
                      return <UiEntity key={checkpoint} uiTransform={{ width: `${100 / CHECKPOINT_SELECT_COLS}%`, height: checkpointSelectCellSize, margin: 2 }} />
                    }
                    const unlocked = checkpoint <= highestUnlockedCheckpoint
                    return (
                      <UiEntity
                        key={checkpoint}
                        uiTransform={{
                          width: `${100 / CHECKPOINT_SELECT_COLS}%`,
                          height: checkpointSelectCellSize,
                          alignItems: 'center',
                          justifyContent: 'center',
                          margin: 2
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
                            uiTransform={{ width: STAT_ICON_SIZE, height: STAT_ICON_SIZE }}
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
              minHeight: '60%',
              maxHeight: '100%',
              flexDirection: 'column',
              alignItems: 'center',
              padding: framePadding,
              borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
              borderColor: Color4.Red()
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
                height: CLOSE_BUTTON_SIZE,
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
              fontSize={28}
              color={SCREEN_TEXT_COLOR}
              uiTransform={{
                margin: { bottom: 12 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: Color4.White()
              }}
            />
            <UiEntity
              uiTransform={{
                flexDirection: 'row',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: Color4.White()
              }}
            >
              <UiEntity
                uiTransform={{
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  margin: { right: 24 },
                  borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                  borderColor: Color4.Green()
                }}
              >
                {RARITIES.map((rarity, rarityIndex) => {
                  const { collected, total } = getRarityProgress(rarity)
                  const rows = Math.ceil((rarity.end - rarity.start + 1) / rarity.rowSize)
                  return (
                    <UiEntity
                      key={rarity.label}
                      uiTransform={{
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        height: rows * codexCellSize,
                        justifyContent: 'center',
                        margin: { bottom: rarityIndex < RARITIES.length - 1 ? 16 : 0 }
                      }}
                    >
                      <Label value={`${collected}/${total}`} fontSize={30} color={SCREEN_TEXT_COLOR} textAlign="middle-right" />
                      <Label value={rarity.label} fontSize={14} color={SCREEN_TEXT_COLOR} textAlign="middle-right" uiTransform={{ margin: { top: -4 } }} />
                    </UiEntity>
                  )
                })}
              </UiEntity>
              <UiEntity
                uiTransform={{
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                  borderColor: Color4.Green()
                }}
              >
                {RARITIES.map((rarity, rarityIndex) => {
                  const rarityTotal = rarity.end - rarity.start + 1
                  const rows = Math.ceil(rarityTotal / rarity.rowSize)
                  return (
                    <UiEntity
                      key={rarity.label}
                      uiTransform={{
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        margin: { bottom: rarityIndex < RARITIES.length - 1 ? 16 : 0 }
                      }}
                    >
                      {Array.from({ length: rows }, (_, rowIndex) => (
                        <UiEntity key={rowIndex} uiTransform={{ height: codexCellSize, flexDirection: 'row', justifyContent: 'flex-start' }}>
                          {Array.from({ length: rarity.rowSize }, (_, colIndex) => {
                            const indexInRarity = rowIndex * rarity.rowSize + colIndex
                            if (indexInRarity >= rarityTotal) return null
                            const slot = rarity.start + indexInRarity
                            const collected = slot < TOTAL_CHECKPOINTS && collectedMonsters[slot]
                            return (
                              <UiEntity
                                key={slot}
                                uiTransform={{
                                  width: codexCellSize,
                                  height: codexCellSize,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  margin: 2
                                }}
                                uiBackground={
                                  collected
                                    ? { textureMode: 'stretch', texture: { src: PRIZE_IMAGE }, uvs: getUvsForQuadrant(slot) }
                                    : slot < TOTAL_CHECKPOINTS
                                      ? { textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: getRarityBadgeUvs(slot) }
                                      : { color: Color4.create(0, 0, 0, 0.5) }
                                }
                              >
                                {collected && (
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
                })}
              </UiEntity>
            </UiEntity>
          </UiEntity>
        )}

        {screen === 'leaderboard' && (
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
              borderColor: Color4.Red()
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
                height: CLOSE_BUTTON_SIZE,
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
              fontSize={28}
              color={SCREEN_TEXT_COLOR}
              uiTransform={{
                margin: { bottom: 12 },
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: Color4.White()
              }}
            />
            <UiEntity
              uiTransform={{
                width: 300,
                flexDirection: 'column',
                borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
                borderColor: Color4.White()
              }}
            >
              {leaderboard.length === 0 ? (
                <Label value="No scores yet" fontSize={16} color={SCREEN_TEXT_COLOR} textAlign="middle-center" />
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
                      borderColor: Color4.Green()
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
          minHeight: '15vh',
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          borderWidth: DEBUG_LAYOUT_BORDERS ? 2 : 0,
          borderColor: Color4.Red()
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
                    height: PRIZE_BACKDROP_SIZE,
                    positionType: 'absolute',
                    position: {
                      top: (PRIZE_BACKDROP_SIZE * PRIZE_PULSE_MAX_SCALE - PRIZE_BACKDROP_SIZE) / 2,
                      left: (PRIZE_BACKDROP_SIZE * PRIZE_PULSE_MAX_SCALE - PRIZE_BACKDROP_SIZE) / 2
                    }
                  }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: PRIZE_IMAGE },
                    uvs: getPrizeUvs(wonMonsterQuadrant)
                  }}
                />
              </UiEntity>
            </UiEntity>
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
