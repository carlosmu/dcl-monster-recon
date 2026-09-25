import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'

// Spider rain: spiders spawn just above the top edge at random X, walk straight down, and are
// removed once they're fully past the bottom edge by SPIDER_DESPAWN_MARGIN_PX.
// spider.png is a 4x4 walk-cycle sheet, frames read row-major from the top-left, animated by
// swapping the quad's uvs each frame (same technique as bitmapFont.tsx).
const SPIDER_IMAGE = 'assets/images/spider.png'
const SPIDER_GRID = 4
const SPIDER_FRAME_COUNT = SPIDER_GRID * SPIDER_GRID
const SPIDER_FPS = 16
const SPIDER_SIZE_PX = 180
const SPIDER_SPEED_MIN_PX = 150
const SPIDER_SPEED_MAX_PX = 250
const SPIDER_SPAWN_INTERVAL_MIN_S = 0.4
const SPIDER_SPAWN_INTERVAL_MAX_S = 1.2
const SPIDER_DESPAWN_MARGIN_PX = 100
// Spiders stay fully inside the central 50% of the screen width.
const SPIDER_SPAWN_BAND_START = 0.1
const SPIDER_SPAWN_BAND_END = 0.9
// Must match setUiRenderer's virtualWidth/virtualHeight in ui.tsx.
const VIRTUAL_WIDTH = 1920
const VIRTUAL_HEIGHT = 1080

type Spider = { id: number; x: number; y: number; speed: number; timeOffset: number }

const spiders: Spider[] = []
let nextSpiderId = 0
let spiderTime = 0
let spawnCooldown = 0

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// Screen size in virtual px. Assumes the renderer scales by the tighter of the two axes (so one
// axis is exactly 1920/1080 and the other is >= its virtual size); falls back to the virtual size
// until the canvas info arrives.
function getScreenSizePx(): { width: number; height: number } {
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return { width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT }
  const scale = Math.min(canvas.width / VIRTUAL_WIDTH, canvas.height / VIRTUAL_HEIGHT)
  return { width: canvas.width / scale, height: canvas.height / scale }
}

engine.addSystem((dt: number) => {
  spiderTime += dt
  const screen = getScreenSizePx()

  spawnCooldown -= dt
  if (spawnCooldown <= 0) {
    spawnCooldown = randomBetween(SPIDER_SPAWN_INTERVAL_MIN_S, SPIDER_SPAWN_INTERVAL_MAX_S)
    spiders.push({
      id: nextSpiderId++,
      x: randomBetween(
        screen.width * SPIDER_SPAWN_BAND_START,
        Math.max(screen.width * SPIDER_SPAWN_BAND_START, screen.width * SPIDER_SPAWN_BAND_END - SPIDER_SIZE_PX)
      ),
      y: -SPIDER_SIZE_PX,
      speed: randomBetween(SPIDER_SPEED_MIN_PX, SPIDER_SPEED_MAX_PX),
      // Desyncs the walk cycles so the spiders don't all step in unison.
      timeOffset: Math.random() * (SPIDER_FRAME_COUNT / SPIDER_FPS)
    })
  }

  for (let i = spiders.length - 1; i >= 0; i--) {
    const spider = spiders[i]
    spider.y += spider.speed * dt
    if (spider.y > screen.height + SPIDER_DESPAWN_MARGIN_PX) spiders.splice(i, 1)
  }
})

function getSpiderUvs(timeOffset: number): number[] {
  const frame = Math.floor((spiderTime + timeOffset) * SPIDER_FPS) % SPIDER_FRAME_COUNT
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

export const SpiderRain = () => (
  <UiEntity
    uiTransform={{
      positionType: 'absolute',
      position: { top: 0, left: 0 },
      width: '100%',
      height: '100%'
    }}
  >
    {spiders.map((spider) => (
      <UiEntity
        key={spider.id}
        uiTransform={{
          positionType: 'absolute',
          position: { top: spider.y, left: spider.x },
          width: SPIDER_SIZE_PX,
          height: SPIDER_SIZE_PX
        }}
        uiBackground={{ textureMode: 'stretch', texture: { src: SPIDER_IMAGE }, uvs: getSpiderUvs(spider.timeOffset) }}
      />
    ))}
    {/* DEBUG: live spider count */}
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 16, right: 16 },
        padding: { top: 4, bottom: 4, left: 8, right: 8 }
      }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.6) }}
    >
      <Label value={`spiders: ${spiders.length}`} fontSize={24} color={Color4.White()} />
    </UiEntity>
  </UiEntity>
)
