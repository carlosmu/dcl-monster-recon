import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'

const DEBUG_CELL_BOUNDS = true

const BACK_IMAGE = 'assets/images/atlas_01.png'
const FRONT_IMAGE = 'assets/images/collection_01.png'
const GRID = 5
const BACK_QUADRANT_A1 = 0 // col 0, row 0 of atlas_01.png
const COLS = 3
const ROWS = 2
// Max seconds a face-up, unmatched cell stays revealed before auto-hiding. Lower this for harder levels.
const FLIP_TIMEOUT = 1
// Board height as a fraction of the real screen height, matched to the original 400px/1080px desktop look.
// Kept as a fraction (not a raw pixel size) so mobile and desktop render the board at the same relative size.
const BOARD_HEIGHT_FRACTION = 400 / 1080
// Seconds allowed to complete the board. Will become per-level configurable later.
const GAME_DURATION = 30
const TIMER_BAR_WIDTH = 300
const TIMER_BAR_HEIGHT = 24

let cellSize = 200 // fallback until the first canvas read

function getUvsForQuadrant(index: number): number[] {
  const col = index % GRID
  const row = Math.floor(index / GRID)
  const u1 = col / GRID
  const u2 = (col + 1) / GRID
  // v=0 is the bottom of the texture, v=1 is the top, so row 0 (A1, top row) must map to the topmost band
  const v1 = (GRID - row - 1) / GRID
  const v2 = (GRID - row) / GRID
  const original: number[] = [u1, v1, u2, v1, u2, v2, u1, v2]
  // rotate 90° clockwise
  return [...original.slice(2), ...original.slice(0, 2)]
}

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

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function buildCells(): CellState[] {
  const pairCount = (COLS * ROWS) / 2
  const pool = Array.from({ length: GRID * GRID }, (_, i) => i)
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

    if (boardVisible && !gameOver) {
      timeRemaining = Math.max(0, timeRemaining - dt)
      if (timeRemaining === 0) {
        gameOver = true
      }
    }

    const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (canvas) {
      const baseCellSize = Math.round((BOARD_HEIGHT_FRACTION * canvas.height) / ROWS)
      cellSize = isMobile() ? Math.round(baseCellSize * 1.5) : baseCellSize
    }
  })
}

export function showBoard() {
  boardVisible = true
  timeRemaining = GAME_DURATION
  gameOver = false
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
    <UiEntity
      uiTransform={{ width: TIMER_BAR_WIDTH, height: TIMER_BAR_HEIGHT, margin: { top: 20 } }}
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
    <UiEntity uiTransform={{ width: '100%', flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}>
      <UiEntity
        uiTransform={{
          width: COLS * cellSize,
          height: ROWS * cellSize,
          flexDirection: 'column'
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, 0.85) }}
      >
        {Array.from({ length: ROWS }, (_, rowIndex) => (
          <UiEntity key={rowIndex} uiTransform={{ width: '100%', height: cellSize, flexDirection: 'row' }}>
            {cells.slice(rowIndex * COLS, rowIndex * COLS + COLS).map((cell, colIndex) => (
              <UiEntity
                key={rowIndex * COLS + colIndex}
                uiTransform={{
                  width: cellSize,
                  height: cellSize,
                  ...(DEBUG_CELL_BOUNDS ? { borderColor: Color4.Red(), borderWidth: 3 } : {})
                }}
                uiBackground={
                  cell.revealed
                    ? { textureMode: 'stretch', texture: { src: FRONT_IMAGE }, uvs: getUvsForQuadrant(cell.frontQuadrant) }
                    : { textureMode: 'stretch', texture: { src: BACK_IMAGE }, uvs: getUvsForQuadrant(BACK_QUADRANT_A1) }
                }
                onMouseDown={() => flipCell(cell)}
              >
                {DEBUG_CELL_BOUNDS && (
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
)
