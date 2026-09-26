import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'

// Critter rain (spiders, bats, ...): critters spawn just off the top (or bottom) edge in a random
// free lane, move straight across the screen, may turn around once, and are removed once they're
// past the opposite edge by despawnMarginPx.
// The image is a grid x grid animation sheet, frames read row-major from the top-left, animated by
// swapping the quad's uvs each frame (same technique as bitmapFont.tsx).

export type CritterRainConfig = {
  image: string
  grid: number
  fps: number
  sizePx: number
  speedMinPx: number
  speedMaxPx: number
  spawnIntervalMinS: number
  spawnIntervalMaxS: number
  despawnMarginPx: number
  // Chance a new critter moves bottom-to-top instead of top-to-bottom.
  upwardChance: number
  // Chance a new critter turns around once, at a random point while fully on screen (between
  // turnAtMin and turnAtMax, as fractions of the room it has to move in).
  turnChance: number
  turnAtMin: number
  turnAtMax: number
  // Draw the sheet mirrored in Y while moving upward, so the critter faces the way it moves.
  mirrorWhenUpward: boolean
  // DEBUG: live count label, e.g. 'spiders', drawn at the top-right at this offset from the top.
  debugLabel: string
  debugLabelTopPx: number
}

// Fixed lanes centered on the screen (8 x 192 = 1536px, i.e. the central 80% of 1920), SHARED by
// every critter rain: only one critter of any kind per lane at a time, so spiders and bats never
// overlap in X. A critter narrower than a lane is centered in it.
const LANE_COUNT = 8
const LANE_WIDTH_PX = 192
const occupiedLanes = new Set<number>()
// Max critters alive at once across every rain (one per occupied lane). Lowering it doesn't remove
// anyone: the extras just finish their walk and no new ones spawn until the count drops below it.
let maxCritters = LANE_COUNT

export function setMaxCritters(max: number): void {
  maxCritters = Math.min(max, LANE_COUNT)
}

// Must match setUiRenderer's virtualWidth/virtualHeight in ui.tsx.
const VIRTUAL_WIDTH = 1920
const VIRTUAL_HEIGHT = 1080

type Critter = { id: number; lane: number; y: number; speed: number; timeOffset: number; upward: boolean; turnAtY: number | null }

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

export function createCritterRain(config: CritterRainConfig) {
  const frameCount = config.grid * config.grid
  const critters: Critter[] = []
  let nextId = 0
  let time = 0
  let spawnCooldown = 0

  engine.addSystem((dt: number) => {
    time += dt
    const screen = getScreenSizePx()

    spawnCooldown -= dt
    if (spawnCooldown <= 0) {
      spawnCooldown = randomBetween(config.spawnIntervalMinS, config.spawnIntervalMaxS)
      const freeLanes: number[] = []
      for (let lane = 0; lane < LANE_COUNT; lane++) {
        if (!occupiedLanes.has(lane)) freeLanes.push(lane)
      }
      // All lanes busy or at the cap: skip this spawn rather than overlap.
      if (freeLanes.length > 0 && occupiedLanes.size < maxCritters) {
        const upward = Math.random() < config.upwardChance
        const lane = freeLanes[Math.floor(Math.random() * freeLanes.length)]
        occupiedLanes.add(lane)
        critters.push({
          id: nextId++,
          lane,
          y: upward ? screen.height : -config.sizePx,
          speed: randomBetween(config.speedMinPx, config.speedMaxPx),
          // Desyncs the animation cycles so the critters don't all move in unison.
          timeOffset: Math.random() * (frameCount / config.fps),
          upward,
          turnAtY:
            Math.random() < config.turnChance
              ? randomBetween(config.turnAtMin, config.turnAtMax) * (screen.height - config.sizePx)
              : null
        })
      }
    }

    for (let i = critters.length - 1; i >= 0; i--) {
      const critter = critters[i]
      // Reversing flips `upward`, which also mirrors the sprite when mirrorWhenUpward is set.
      if (critter.turnAtY !== null && (critter.upward ? critter.y <= critter.turnAtY : critter.y >= critter.turnAtY)) {
        critter.upward = !critter.upward
        critter.turnAtY = null
      }
      critter.y += (critter.upward ? -critter.speed : critter.speed) * dt
      const gone = critter.upward
        ? critter.y + config.sizePx < -config.despawnMarginPx
        : critter.y > screen.height + config.despawnMarginPx
      if (gone) {
        occupiedLanes.delete(critter.lane)
        critters.splice(i, 1)
      }
    }
  })

  function getLaneX(lane: number): number {
    const lanesStart = (getScreenSizePx().width - LANE_COUNT * LANE_WIDTH_PX) / 2
    return lanesStart + lane * LANE_WIDTH_PX + (LANE_WIDTH_PX - config.sizePx) / 2
  }

  function getUvs(timeOffset: number, mirrorY: boolean): number[] {
    const frame = Math.floor((time + timeOffset) * config.fps) % frameCount
    const col = frame % config.grid
    const row = Math.floor(frame / config.grid)
    const u1 = col / config.grid
    const u2 = (col + 1) / config.grid
    // v=0 is the bottom of the texture, so row 0 (top row) maps to the topmost band
    const v1 = (config.grid - row - 1) / config.grid
    const v2 = (config.grid - row) / config.grid
    // uvs go bottom-left, top-left, top-right, bottom-right (clockwise), per PBUiBackground;
    // swapping v1/v2 samples the frame upside down
    return mirrorY ? [u1, v2, u1, v1, u2, v1, u2, v2] : [u1, v1, u1, v2, u2, v2, u2, v1]
  }

  return () => (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 0, left: 0 },
        width: '100%',
        height: '100%'
      }}
    >
      {critters.map((critter) => (
        <UiEntity
          key={critter.id}
          uiTransform={{
            positionType: 'absolute',
            position: { top: critter.y, left: getLaneX(critter.lane) },
            width: config.sizePx,
            height: config.sizePx
          }}
          uiBackground={{
            textureMode: 'stretch',
            texture: { src: config.image },
            uvs: getUvs(critter.timeOffset, config.mirrorWhenUpward && critter.upward)
          }}
        />
      ))}
      {/* DEBUG: live critter count */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: config.debugLabelTopPx, right: 16 },
          padding: { top: 4, bottom: 4, left: 8, right: 8 }
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, 0.6) }}
      >
        <Label value={`${config.debugLabel}: ${critters.length}`} fontSize={24} color={Color4.White()} />
      </UiEntity>
    </UiEntity>
  )
}
