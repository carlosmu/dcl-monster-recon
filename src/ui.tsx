import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'

const DEBUG_CELL_LABELS = true

const BACK_IMAGE = 'assets/images/atlas_01.png'
const FRONT_IMAGE = 'assets/images/collection_01.png'
// Cropped from atlas_01.png quadrants F1-H3. Nine-slicing in DCL only reads the full
// texture (no custom uvs), so the frame art had to be exported as its own file.
const FRAME_IMAGE = 'assets/images/frame_01.png'
// Fraction of the frame texture occupied by each corner ornament, measured so the wood/metal
// corners (and the baked-in close button) don't get stretched.
const FRAME_SLICE = 0.22
const FRONT_GRID = 5 // collection_01.png grid
const BACK_ATLAS_GRID = 8 // atlas_01.png grid

type Difficulty = 'easy' | 'medium' | 'hard'

interface DifficultyConfig {
  cols: number
  rows: number
  duration: number
  flipTimeout: number
  scoreMultiplier: number
}

const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  easy: { cols: 3, rows: 2, duration: 30, flipTimeout: 1, scoreMultiplier: 1 },
  medium: { cols: 4, rows: 3, duration: 30, flipTimeout: 1, scoreMultiplier: 1.5 },
  hard: { cols: 4, rows: 4, duration: 30, flipTimeout: 1, scoreMultiplier: 2 }
}

const CURRENT_DIFFICULTY: Difficulty = 'easy'
const {
  cols: COLS,
  rows: ROWS,
  duration: GAME_DURATION,
  flipTimeout: FLIP_TIMEOUT,
  scoreMultiplier: SCORE_MULTIPLIER
} = DIFFICULTIES[CURRENT_DIFFICULTY]

// Board height as a fraction of the real screen height, matched to the original 400px/1080px desktop look.
// Kept as a fraction (not a raw pixel size) so mobile and desktop render the board at the same relative size.
const BOARD_HEIGHT_FRACTION = 400 / 1080
const TIMER_BAR_WIDTH = 300
const TIMER_BAR_HEIGHT = 24
// Frame padding as a fraction of the real screen height, matched to a 96px/1080px desktop look.
const FRAME_PADDING_FRACTION = 96 / 1080
// Width of canvas_main (the safe-area column) as a fraction of screen width. Shared between the
// layout and the cellSize calculation so the grid never grows wider than the column it sits in.
const CANVAS_MAIN_WIDTH_FRACTION = 0.4
const LEVEL = 1

const BASE_POINTS_PER_PAIR = 100
const TIME_BONUS_MAX = 200
const ERROR_PENALTY = 10

// Seconds the "Monster collected!" / "Time's up" screen stays up before the board closes on its own.
const END_SCREEN_DURATION = 3

let cellSize = 200 // fallback until the first canvas read
let framePadding = 32 // fallback until the first canvas read

function getUvsForBlock(col: number, row: number, colSpan: number, rowSpan: number, grid: number): number[] {
  const u1 = col / grid
  const u2 = (col + colSpan) / grid
  // v=0 is the bottom of the texture, v=1 is the top, so row 0 (A1, top row) must map to the topmost band
  const v1 = (grid - row - rowSpan) / grid
  const v2 = (grid - row) / grid
  const original: number[] = [u1, v1, u2, v1, u2, v2, u1, v2]
  // rotate 90° clockwise
  return [...original.slice(2), ...original.slice(0, 2)]
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

let boardVisible = false
let cells: CellState[] = []
let elapsedTime = 0
let revealedUnmatched: CellState[] = []
let timeRemaining = GAME_DURATION
let gameOver = false
let won = false
let wonMonsterQuadrant = 0
let errors = 0
let score = 0
let endScreenShownAt: number | null = null

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
        wonMonsterQuadrant = Math.floor(Math.random() * FRONT_GRID * FRONT_GRID)
        const pairCount = (COLS * ROWS) / 2
        const timeBonus = Math.round((timeRemaining / GAME_DURATION) * TIME_BONUS_MAX * SCORE_MULTIPLIER)
        score = Math.max(0, pairCount * BASE_POINTS_PER_PAIR * SCORE_MULTIPLIER + timeBonus - errors * ERROR_PENALTY)
        endScreenShownAt = elapsedTime
      }
    } else {
      errors++
    }
  }
}

export function setupUi() {
  cells = buildCells()
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

    if (boardVisible && !gameOver && !won) {
      timeRemaining = Math.max(0, timeRemaining - dt)
      if (timeRemaining === 0) {
        gameOver = true
        endScreenShownAt = elapsedTime
      }
    }

    if (endScreenShownAt !== null && elapsedTime - endScreenShownAt >= END_SCREEN_DURATION) {
      boardVisible = false
      endScreenShownAt = null
    }

    const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (canvas) {
      const basePadding = Math.round(FRAME_PADDING_FRACTION * canvas.height)
      framePadding = isMobile() ? Math.round(basePadding * 1.5) : basePadding

      const heightCellSize = Math.floor((BOARD_HEIGHT_FRACTION * canvas.height) / ROWS)
      const availableWidth = CANVAS_MAIN_WIDTH_FRACTION * canvas.width - 2 * framePadding
      const widthCellSize = Math.floor(availableWidth / COLS)
      const baseCellSize = Math.min(heightCellSize, widthCellSize)
      cellSize = isMobile() ? Math.round(baseCellSize * 1.5) : baseCellSize
    }
  })
}

export function showBoard() {
  cells = buildCells()
  revealedUnmatched = []
  boardVisible = true
  timeRemaining = GAME_DURATION
  gameOver = false
  won = false
  errors = 0
  score = 0
  endScreenShownAt = null
}

const MemoryMatchUi = () => (
  <UiEntity
    uiTransform={{
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      alignItems: 'center',
      display: boardVisible ? 'flex' : 'none'
    }}
    uiBackground={{ color: Color4.create(0, 0, 0, 0.2) }}
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
      {/* header */}
      <UiEntity
        uiTransform={{
          width: '100%',
          minHeight: '15vh',
          flexDirection: 'row',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: Color4.Red()
        }}
      >
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
        <UiEntity
          uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: framePadding }}
          uiBackground={{
            textureMode: 'nine-slices',
            texture: { src: FRAME_IMAGE },
            textureSlices: { top: FRAME_SLICE, bottom: FRAME_SLICE, left: FRAME_SLICE, right: FRAME_SLICE }
          }}
        >
          <Label value={`Level ${LEVEL}`} fontSize={28} color={Color4.White()} uiTransform={{ margin: { bottom: 12 } }} />
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
      </UiEntity>

      {/* footer: reserved for notifications */}
      <UiEntity
        uiTransform={{
          width: '100%',
          minHeight: '15vh',
          flexDirection: 'row',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: Color4.Red()
        }}
      />

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
          uiBackground={{ color: Color4.create(0, 0, 0, 0.8) }}
        >
          {won ? (
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
              <Label value="Monster collected!" fontSize={36} color={Color4.White()} />
              <Label value={`+${score} pts`} fontSize={24} color={Color4.White()} uiTransform={{ margin: { top: 8 } }} />
              <UiEntity
                uiTransform={{ width: 180, height: 180, margin: { top: 20 } }}
                uiBackground={{
                  textureMode: 'stretch',
                  texture: { src: FRONT_IMAGE },
                  uvs: getUvsForQuadrant(wonMonsterQuadrant)
                }}
              />
            </UiEntity>
          ) : (
            <Label value="Time's up" fontSize={36} color={Color4.White()} />
          )}
        </UiEntity>
      )}
    </UiEntity>
  </UiEntity>
)
