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
// Board height as a fraction of the real screen height, matched to the original 400px/1080px desktop look.
// Kept as a fraction (not a raw pixel size) so mobile and desktop render the board at the same relative size.
const BOARD_HEIGHT_FRACTION = 400 / 1080

let cellSize = 200 // fallback until the first canvas read

function randomIndex(): number {
  return Math.floor(Math.random() * GRID * GRID)
}

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
}

let boardVisible = false
let cells: CellState[] = []

function buildCells(): CellState[] {
  const result: CellState[] = []
  for (let i = 0; i < COLS * ROWS; i++) {
    result.push({ frontQuadrant: randomIndex(), revealed: false })
  }
  return result
}

function revealCell(cell: CellState) {
  if (cell.revealed) return
  cell.revealed = true
}

export function setupUi() {
  cells = buildCells()
  ReactEcsRenderer.setUiRenderer(MemoryMatchUi)
  engine.addSystem(() => {
    const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (canvas) {
      const baseCellSize = Math.round((BOARD_HEIGHT_FRACTION * canvas.height) / ROWS)
      cellSize = isMobile() ? Math.round(baseCellSize * 1.5) : baseCellSize
    }
  })
}

export function showBoard() {
  boardVisible = true
}

const MemoryMatchUi = () => (
  <UiEntity
    uiTransform={{
      width: '100%',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      display: boardVisible ? 'flex' : 'none'
    }}
    uiBackground={{ color: Color4.create(0, 0, 0, 0.2) }}
  >
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
              onMouseDown={() => revealCell(cell)}
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
)
