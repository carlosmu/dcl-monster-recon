import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'

// Spider rain: spiders spawn just off the top (or bottom) edge at random X, walk straight across
// the screen, and are removed once they're past the opposite edge by SPIDER_DESPAWN_MARGIN_PX.
// Upward walkers draw the sheet mirrored in Y so they face the way they move.
// spider.png is a 4x4 walk-cycle sheet, frames read row-major from the top-left, animated by
// swapping the quad's uvs each frame (same technique as bitmapFont.tsx).
const SPIDER_IMAGE = 'assets/images/spider.png'
const SPIDER_GRID = 4
const SPIDER_FRAME_COUNT = SPIDER_GRID * SPIDER_GRID
const SPIDER_FPS = 16
const SPIDER_SIZE_PX = 192
const SPIDER_SPEED_MIN_PX = 150
const SPIDER_SPEED_MAX_PX = 250
const SPIDER_SPAWN_INTERVAL_MIN_S = 0.4
const SPIDER_SPAWN_INTERVAL_MAX_S = 1.2
const SPIDER_DESPAWN_MARGIN_PX = 100
// Spiders walk in fixed, spider-wide lanes centered on the screen (8 x 192 = 1536px, i.e. the
// central 80% of 1920). Only one spider per lane at a time, so they never overlap in X.
const SPIDER_LANE_COUNT = 8
// Chance a new spider walks bottom-to-top instead of top-to-bottom.
const SPIDER_UPWARD_CHANCE = 0.5
// Chance a new spider turns around once, at a random point while fully on screen (the band below,
// as fractions of the room it has to move in). Safe for overlap: it keeps its lane to itself.
const SPIDER_TURN_CHANCE = 0.3
const SPIDER_TURN_AT_MIN = 0.15
const SPIDER_TURN_AT_MAX = 0.85
// Must match setUiRenderer's virtualWidth/virtualHeight in ui.tsx.
const VIRTUAL_WIDTH = 1920
const VIRTUAL_HEIGHT = 1080

type Spider = { id: number; lane: number; y: number; speed: number; timeOffset: number; upward: boolean; turnAtY: number | null }

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
    const freeLanes: number[] = []
    for (let lane = 0; lane < SPIDER_LANE_COUNT; lane++) {
      if (!spiders.some((spider) => spider.lane === lane)) freeLanes.push(lane)
    }
    // All lanes busy: skip this spawn rather than overlap.
    if (freeLanes.length > 0) {
      const upward = Math.random() < SPIDER_UPWARD_CHANCE
      spiders.push({
        id: nextSpiderId++,
        lane: freeLanes[Math.floor(Math.random() * freeLanes.length)],
        y: upward ? screen.height : -SPIDER_SIZE_PX,
        speed: randomBetween(SPIDER_SPEED_MIN_PX, SPIDER_SPEED_MAX_PX),
        // Desyncs the walk cycles so the spiders don't all step in unison.
        timeOffset: Math.random() * (SPIDER_FRAME_COUNT / SPIDER_FPS),
        upward,
        turnAtY:
          Math.random() < SPIDER_TURN_CHANCE
            ? randomBetween(SPIDER_TURN_AT_MIN, SPIDER_TURN_AT_MAX) * (screen.height - SPIDER_SIZE_PX)
            : null
      })
    }
  }

  for (let i = spiders.length - 1; i >= 0; i--) {
    const spider = spiders[i]
    // Reversing flips `upward`, which also mirrors the sprite (see getSpiderUvs).
    if (spider.turnAtY !== null && (spider.upward ? spider.y <= spider.turnAtY : spider.y >= spider.turnAtY)) {
      spider.upward = !spider.upward
      spider.turnAtY = null
    }
    if (spider.upward) {
      spider.y -= spider.speed * dt
      if (spider.y + SPIDER_SIZE_PX < -SPIDER_DESPAWN_MARGIN_PX) spiders.splice(i, 1)
    } else {
      spider.y += spider.speed * dt
      if (spider.y > screen.height + SPIDER_DESPAWN_MARGIN_PX) spiders.splice(i, 1)
    }
  }
})

function getLaneX(lane: number): number {
  const lanesStart = (getScreenSizePx().width - SPIDER_LANE_COUNT * SPIDER_SIZE_PX) / 2
  return lanesStart + lane * SPIDER_SIZE_PX
}

function getSpiderUvs(timeOffset: number, mirrorY: boolean): number[] {
  const frame = Math.floor((spiderTime + timeOffset) * SPIDER_FPS) % SPIDER_FRAME_COUNT
  const col = frame % SPIDER_GRID
  const row = Math.floor(frame / SPIDER_GRID)
  const u1 = col / SPIDER_GRID
  const u2 = (col + 1) / SPIDER_GRID
  // v=0 is the bottom of the texture, so row 0 (top row) maps to the topmost band
  const v1 = (SPIDER_GRID - row - 1) / SPIDER_GRID
  const v2 = (SPIDER_GRID - row) / SPIDER_GRID
  // uvs go bottom-left, top-left, top-right, bottom-right (clockwise), per PBUiBackground;
  // swapping v1/v2 samples the frame upside down
  return mirrorY ? [u1, v2, u1, v1, u2, v1, u2, v2] : [u1, v1, u1, v2, u2, v2, u2, v1]
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
          position: { top: spider.y, left: getLaneX(spider.lane) },
          width: SPIDER_SIZE_PX,
          height: SPIDER_SIZE_PX
        }}
        uiBackground={{ textureMode: 'stretch', texture: { src: SPIDER_IMAGE }, uvs: getSpiderUvs(spider.timeOffset, spider.upward) }}
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
