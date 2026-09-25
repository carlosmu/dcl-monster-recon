import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'

// Walk-cycle test: spider.png is a 4x4 sheet, frames read row-major from the top-left.
// Animated by swapping the quad's uvs each frame (same technique as bitmapFont.tsx).
const SPIDER_IMAGE = 'assets/images/spider.png'
const SPIDER_GRID = 4
const SPIDER_FRAME_COUNT = SPIDER_GRID * SPIDER_GRID
const SPIDER_FPS = 8
const SPIDER_SIZE_PX = 300

let spiderTime = 0
engine.addSystem((dt: number) => {
  spiderTime += dt
})

function getSpiderUvs(): number[] {
  const frame = Math.floor(spiderTime * SPIDER_FPS) % SPIDER_FRAME_COUNT
  const col = frame % SPIDER_GRID
  const row = Math.floor(frame / SPIDER_GRID)
  const u1 = col / SPIDER_GRID
  const u2 = (col + 1) / SPIDER_GRID
  // v=0 is the bottom of the texture, so row 0 (top row) maps to the topmost band
  const v1 = (SPIDER_GRID - row - 1) / SPIDER_GRID
  const v2 = (SPIDER_GRID - row) / SPIDER_GRID
  // uvs go bottom-left, top-left, top-right, bottom-right (clockwise), per PBUiBackground
  return [u1, v1, u1, v2, u2, v2, u2, v1]
}

export const SpiderSprite = () => (
  <UiEntity
    uiTransform={{
      positionType: 'absolute',
      position: { top: 0, left: 0 },
      width: '100%',
      height: '100%',
      justifyContent: 'center',
      alignItems: 'center'
    }}
  >
    <UiEntity
      uiTransform={{ width: SPIDER_SIZE_PX, height: SPIDER_SIZE_PX }}
      uiBackground={{ textureMode: 'stretch', texture: { src: SPIDER_IMAGE }, uvs: getSpiderUvs() }}
    />
  </UiEntity>
)
