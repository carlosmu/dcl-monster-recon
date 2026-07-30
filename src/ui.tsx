import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation, AudioSource, Transform, type Entity } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import checkpointsData from './checkpoints.json'

const DEBUG_CELL_LABELS = true

const BACK_IMAGE = 'assets/images/atlas_01.png'
const FRONT_IMAGE = 'assets/images/cards_01.png'
const PRIZE_IMAGE = 'assets/images/prizes_01.png'
const BOARD_MUSIC_CLIP = 'assets/audio/tuntun.mp3'
const BOARD_END_CLIP = 'assets/audio/tararan.mp3'
const PRIZE_CLIP = 'assets/audio/fanfare.mp3'
// Cropped from atlas_01.png quadrants F1-H3. Nine-slicing in DCL only reads the full
// texture (no custom uvs), so the frame art had to be exported as its own file.
const FRAME_IMAGE = 'assets/images/frame_01.png'
// Fraction of the frame texture occupied by each corner ornament, measured so the wood/metal
// corners (and the baked-in close button) don't get stretched.
const FRAME_SLICE = 0.22
const FRONT_GRID = 5 // cards_01.png / prizes_01.png grid
const BACK_ATLAS_GRID = 8 // atlas_01.png grid

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
const TIMER_BAR_WIDTH = 300
const TIMER_BAR_HEIGHT = 24
const HEADER_BUTTON_WIDTH = 110
const HEADER_BUTTON_HEIGHT = 40
const CLOSE_BUTTON_SIZE = 32
// Frame padding as a fraction of the real screen height, matched to a 96px/1080px desktop look.
const FRAME_PADDING_FRACTION = 96 / 1080
// Width of canvas_main (the safe-area column) as a fraction of screen width. Shared between the
// layout and the cellSize calculation so the grid never grows wider than the column it sits in.
const CANVAS_MAIN_WIDTH_FRACTION = 0.4

const BASE_POINTS_PER_PAIR = 100
const TIME_BONUS_MAX = 200
const ERROR_PENALTY = 10

// Seconds the "Monster collected!" / "Time's up" screen stays up before the board closes on its own.
const END_SCREEN_DURATION = 3

// Placeholder notification copy — will be replaced with real event-driven messages later.
const NOTIFICATION_MESSAGES = [
  'Cryptonauta ha capturado un pepino mutante',
  '0xGorducho encontró un caracol con rayos láser',
  'SatoshiWalker desenterró un sapo con casco espacial',
  'PixelKilla atrapó una araña bioluminiscente',
  'ByteHunter cazó un pulpo con gorra de piloto'
]
const NOTIFICATION_INTERVAL = 10 // seconds between notifications
const NOTIFICATION_VISIBLE_DURATION = 4 // seconds each notification stays on screen

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

interface CellState {
  frontQuadrant: number
  revealed: boolean
  matched: boolean
  flippedAt: number | null
}

// 'hidden' until the in-world Play button opens the checkpoint select screen.
type Screen = 'hidden' | 'checkpointSelect' | 'board' | 'inventory'

let screen: Screen = 'hidden'
let currentCheckpoint = 1
let currentBoardIndex = 0 // 0-based index into the current checkpoint's boards array
// In-memory only for now — will be replaced by progress read from the authoritative server.
let highestUnlockedCheckpoint = 1
// One slot per checkpoint; true once that checkpoint's monster prize has been collected.
const collectedMonsters: boolean[] = new Array(TOTAL_CHECKPOINTS).fill(false)
const CHECKPOINT_SELECT_COLS = FRONT_GRID
const CHECKPOINT_SELECT_ROWS = Math.ceil(TOTAL_CHECKPOINTS / CHECKPOINT_SELECT_COLS)
let checkpointSelectCellSize = 80 // fallback until the first canvas read

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
  if (gameOver || cell.matched || cell.revealed) return

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
      if (cells.every((c) => c.matched)) {
        won = true
        stopBoardMusic()
        playBoardEndSound()
        const pairCount = (COLS * ROWS) / 2
        const timeBonus = Math.round((timeRemaining / GAME_DURATION) * TIME_BONUS_MAX * SCORE_MULTIPLIER)
        score = Math.max(0, pairCount * BASE_POINTS_PER_PAIR * SCORE_MULTIPLIER + timeBonus - errors * ERROR_PENALTY)
        totalScore += score

        const boardsInCheckpoint = CHECKPOINTS[currentCheckpoint - 1].boards.length
        checkpointComplete = currentBoardIndex === boardsInCheckpoint - 1
        if (checkpointComplete) {
          wonMonsterQuadrant = currentCheckpoint - 1
          collectedMonsters[currentCheckpoint - 1] = true
          if (currentCheckpoint === highestUnlockedCheckpoint && highestUnlockedCheckpoint < TOTAL_CHECKPOINTS) {
            highestUnlockedCheckpoint++
          }
        }
        endScreenShownAt = elapsedTime
      }
    } else {
      errors++
    }
  }
}

let boardMusicEntity: Entity
let boardEndEntity: Entity
let prizeEntity: Entity

function playBoardMusic() {
  AudioSource.getMutable(boardMusicEntity).playing = true
}

function stopBoardMusic() {
  AudioSource.getMutable(boardMusicEntity).playing = false
}

function playBoardEndSound() {
  // playSound() always emits a CRDT PUT, so repeated calls reliably retrigger from the start
  // (unlike toggling `playing` directly, which can collapse same-tick writes and no-op).
  AudioSource.playSound(boardEndEntity, BOARD_END_CLIP, true)
}

function playPrizeSound() {
  AudioSource.playSound(prizeEntity, PRIZE_CLIP, true)
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

  ReactEcsRenderer.setUiRenderer(MemoryMatchUi)
  engine.addSystem((dt: number) => {
    elapsedTime += dt
    if (revealedUnmatched.length > 0) {
      revealedUnmatched = revealedUnmatched.filter((cell) => {
        if (cell.flippedAt !== null && elapsedTime - cell.flippedAt >= FLIP_TIMEOUT) {
          hideCell(cell)
          return false
        }
        return true
      })
    }

    if (screen === 'board' && !gameOver && !won) {
      timeRemaining = Math.max(0, timeRemaining - dt)
      if (timeRemaining === 0) {
        gameOver = true
        stopBoardMusic()
        playBoardEndSound()
        endScreenShownAt = elapsedTime
      }
    }

    if (endScreenShownAt !== null && elapsedTime - endScreenShownAt >= END_SCREEN_DURATION) {
      if (won && !checkpointComplete) {
        startBoard(currentCheckpoint, currentBoardIndex + 1)
      } else if (won && checkpointComplete && !showingPrize) {
        showingPrize = true
        playPrizeSound()
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
  playBoardMusic()
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
        a sibling "canvas_sidebar" can be added later for anything that belongs outside this column. */}
    <UiEntity
      uiTransform={{
        width: `${CANVAS_MAIN_WIDTH_FRACTION * 100}%`,
        height: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: { top: '1vh', bottom: '1vh' },
        borderWidth: 2,
        borderColor: Color4.Green()
      }}
    >
      {/* header: left (score + tbd), middle (timer / play), right (inventory / checkpoints) */}
      <UiEntity
        uiTransform={{
          width: '100%',
          minHeight: '15vh',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderWidth: 2,
          borderColor: Color4.Red()
        }}
      >
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', margin: { right: 12 } }}>
            <Label value="Score" fontSize={14} color={Color4.White()} />
            <Label value={`${totalScore}`} fontSize={20} color={Color4.White()} />
          </UiEntity>
          {/* second left slot: TBD */}
          <UiEntity uiTransform={{ width: HEADER_BUTTON_WIDTH, height: HEADER_BUTTON_HEIGHT }} />
        </UiEntity>

        <UiEntity uiTransform={{ alignItems: 'center', justifyContent: 'center' }}>
          {screen === 'board' ? (
            <UiEntity
              uiTransform={{ width: TIMER_BAR_WIDTH, height: TIMER_BAR_HEIGHT }}
              uiBackground={{ color: Color4.create(0, 0, 0, 0.6) }}
            >
              <UiEntity
                uiTransform={{ width: `${(timeRemaining / GAME_DURATION) * 100}%`, height: '100%' }}
                uiBackground={{ color: Color4.create(0.2, 0.6, 0.9, 1) }}
              />
              <Label
                value={`${Math.ceil(timeRemaining)}s`}
                fontSize={18}
                color={Color4.White()}
                textAlign="middle-center"
                uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
              />
            </UiEntity>
          ) : (
            <UiEntity
              uiTransform={{
                width: HEADER_BUTTON_WIDTH,
                height: HEADER_BUTTON_HEIGHT,
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ color: Color4.create(0.2, 0.7, 0.3, 1) }}
              onMouseDown={() => showCheckpointSelect()}
            >
              <Label value="PLAY" fontSize={20} color={Color4.White()} textAlign="middle-center" />
            </UiEntity>
          )}
        </UiEntity>

        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
          <UiEntity
            uiTransform={{
              width: HEADER_BUTTON_WIDTH,
              height: HEADER_BUTTON_HEIGHT,
              alignItems: 'center',
              justifyContent: 'center',
              margin: { right: 8 }
            }}
            uiBackground={{ color: Color4.create(0.3, 0.3, 0.3, 1) }}
            onMouseDown={() => showInventory()}
          >
            <Label value="Monster Codex" fontSize={14} color={Color4.White()} textAlign="middle-center" />
          </UiEntity>
          <UiEntity
            uiTransform={{
              width: HEADER_BUTTON_WIDTH,
              height: HEADER_BUTTON_HEIGHT,
              alignItems: 'center',
              justifyContent: 'center'
            }}
            uiBackground={{ color: Color4.create(0.3, 0.3, 0.3, 1) }}
            onMouseDown={() => showCheckpointSelect()}
          >
            <Label value="Checkpoints" fontSize={14} color={Color4.White()} textAlign="middle-center" />
          </UiEntity>
        </UiEntity>
      </UiEntity>

      {/* body */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 'auto',
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: Color4.Red()
        }}
      >
        {screen === 'board' && (
          <UiEntity
            uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: framePadding }}
            uiBackground={{
              textureMode: 'nine-slices',
              texture: { src: FRAME_IMAGE },
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
              uiBackground={{ color: Color4.Red() }}
              onMouseDown={() => closeBoard()}
            >
              <Label value="X" fontSize={18} color={Color4.White()} textAlign="middle-center" />
            </UiEntity>
            <Label
              value={`Checkpoint ${currentCheckpoint} · Board ${currentBoardIndex + 1}/${CHECKPOINTS[currentCheckpoint - 1].boards.length}`}
              fontSize={28}
              color={Color4.White()}
              uiTransform={{ margin: { bottom: 12 } }}
            />
            <UiEntity
              uiTransform={{
                width: COLS * cellSize,
                height: ROWS * cellSize,
                flexDirection: 'column'
              }}
            >
              {Array.from({ length: ROWS }, (_, rowIndex) => (
                <UiEntity key={rowIndex} uiTransform={{ width: '100%', height: cellSize, flexDirection: 'row' }}>
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
            </UiEntity>
          </UiEntity>
        )}

        {screen === 'checkpointSelect' && (
          <UiEntity
            uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: framePadding }}
            uiBackground={{
              textureMode: 'nine-slices',
              texture: { src: FRAME_IMAGE },
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
              uiBackground={{ color: Color4.Red() }}
              onMouseDown={() => closeCheckpointSelect()}
            >
              <Label value="X" fontSize={18} color={Color4.White()} textAlign="middle-center" />
            </UiEntity>
            <Label value="Select checkpoint" fontSize={28} color={Color4.White()} uiTransform={{ margin: { bottom: 12 } }} />
            <UiEntity
              uiTransform={{
                width: CHECKPOINT_SELECT_COLS * checkpointSelectCellSize,
                height: CHECKPOINT_SELECT_ROWS * checkpointSelectCellSize,
                flexDirection: 'column'
              }}
            >
              {Array.from({ length: CHECKPOINT_SELECT_ROWS }, (_, rowIndex) => (
                <UiEntity key={rowIndex} uiTransform={{ width: '100%', height: checkpointSelectCellSize, flexDirection: 'row' }}>
                  {Array.from({ length: CHECKPOINT_SELECT_COLS }, (_, colIndex) => {
                    const checkpoint = rowIndex * CHECKPOINT_SELECT_COLS + colIndex + 1
                    if (checkpoint > TOTAL_CHECKPOINTS) {
                      return <UiEntity key={checkpoint} uiTransform={{ width: checkpointSelectCellSize, height: checkpointSelectCellSize, margin: 2 }} />
                    }
                    const unlocked = checkpoint <= highestUnlockedCheckpoint
                    return (
                      <UiEntity
                        key={checkpoint}
                        uiTransform={{
                          width: checkpointSelectCellSize,
                          height: checkpointSelectCellSize,
                          alignItems: 'center',
                          justifyContent: 'center',
                          margin: 2
                        }}
                        uiBackground={{ color: unlocked ? Color4.create(0.2, 0.6, 0.9, 0.6) : Color4.create(0, 0, 0, 0.5) }}
                        onMouseDown={unlocked ? () => startCheckpoint(checkpoint) : undefined}
                      >
                        <Label
                          value={unlocked ? `Checkpoint ${String(checkpoint).padStart(2, '0')}` : 'Locked'}
                          fontSize={14}
                          color={Color4.White()}
                          textAlign="middle-center"
                        />
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
            uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: framePadding }}
            uiBackground={{
              textureMode: 'nine-slices',
              texture: { src: FRAME_IMAGE },
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
              uiBackground={{ color: Color4.Red() }}
              onMouseDown={() => closeInventory()}
            >
              <Label value="X" fontSize={18} color={Color4.White()} textAlign="middle-center" />
            </UiEntity>
            <Label value="Monster Codex" fontSize={28} color={Color4.White()} uiTransform={{ margin: { bottom: 12 } }} />
            <UiEntity
              uiTransform={{
                width: CHECKPOINT_SELECT_COLS * checkpointSelectCellSize,
                height: CHECKPOINT_SELECT_ROWS * checkpointSelectCellSize,
                flexDirection: 'column'
              }}
            >
              {Array.from({ length: CHECKPOINT_SELECT_ROWS }, (_, rowIndex) => (
                <UiEntity key={rowIndex} uiTransform={{ width: '100%', height: checkpointSelectCellSize, flexDirection: 'row' }}>
                  {Array.from({ length: CHECKPOINT_SELECT_COLS }, (_, colIndex) => {
                    const slot = rowIndex * CHECKPOINT_SELECT_COLS + colIndex
                    const collected = slot < TOTAL_CHECKPOINTS && collectedMonsters[slot]
                    return (
                      <UiEntity
                        key={slot}
                        uiTransform={{
                          width: checkpointSelectCellSize,
                          height: checkpointSelectCellSize,
                          alignItems: 'center',
                          justifyContent: 'center',
                          margin: 2
                        }}
                        uiBackground={
                          collected
                            ? { textureMode: 'stretch', texture: { src: PRIZE_IMAGE }, uvs: getUvsForQuadrant(slot) }
                            : { color: Color4.create(0, 0, 0, 0.5) }
                        }
                      >
                        {!collected && <Label value="?" fontSize={14} color={Color4.White()} textAlign="middle-center" />}
                      </UiEntity>
                    )
                  })}
                </UiEntity>
              ))}
            </UiEntity>
          </UiEntity>
        )}
      </UiEntity>

      {/* footer: notifications */}
      <UiEntity
        uiTransform={{
          width: '100%',
          minHeight: '15vh',
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          borderWidth: 2,
          borderColor: Color4.Red()
        }}
      >
        {currentNotification && (
          <UiEntity
            uiTransform={{ padding: { top: 10, bottom: 10, left: 20, right: 20 }, borderRadius: 16 }}
            uiBackground={{ color: Color4.create(0, 0, 0, 0.75) }}
          >
            <Label value={currentNotification} fontSize={16} color={Color4.White()} textAlign="middle-center" />
          </UiEntity>
        )}
      </UiEntity>

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
        uiBackground={{ color: Color4.create(0, 0, 0, 0.95) }}
      >
        {won ? (
          showingPrize ? (
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
              <Label value="Monster collected!" fontSize={36} color={Color4.White()} />
              <UiEntity
                uiTransform={{ width: 180, height: 180, margin: { top: 20 } }}
                uiBackground={{
                  textureMode: 'stretch',
                  texture: { src: PRIZE_IMAGE },
                  uvs: getUvsForQuadrant(wonMonsterQuadrant)
                }}
              />
            </UiEntity>
          ) : (
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
              <Label value="Board complete!" fontSize={36} color={Color4.White()} />
              <Label value={`+${score} pts`} fontSize={24} color={Color4.White()} uiTransform={{ margin: { top: 8 } }} />
            </UiEntity>
          )
        ) : (
          <Label value="Time's up" fontSize={36} color={Color4.White()} />
        )}
      </UiEntity>
    )}
  </UiEntity>
)
