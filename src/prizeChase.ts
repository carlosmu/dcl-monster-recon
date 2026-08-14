import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Billboard,
  BillboardMode,
  Tween,
  TweenSequence,
  TweenLoop,
  EasingFunction,
  TriggerArea,
  triggerAreaEventsSystem,
  ParticleSystem,
  PBParticleSystem_BlendMode,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Vector2, Color3, Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { getWorldPosition, timers } from '@dcl-sdk/utils'
import { EntityNames } from '../assets/scene/entity-names'
import { guard } from './errorTrap'

// One-shot sparkle burst at the exact spot a prize was caught. Adapted from a fireworks manager
// copied from a different (match-based) project - dropped its GameState-phase trigger and its
// multi-entity "Firework_N" cascade (both specific to that game's arena setup), kept the particle
// config shape and the utils.timers cleanup pattern. Particles only render in the Unity desktop
// Explorer (not mobile/Godot) - a known SDK limitation, not a bug here.
const CATCH_BURST_LIFETIME = 2.5
const CATCH_BURST_CLEANUP_DELAY_MS = 3000 // a bit more than lifetime, so particles finish naturally

function spawnCatchBurst(position: Vector3) {
  const burst = engine.addEntity()
  Transform.create(burst, { position })
  ParticleSystem.create(burst, {
    loop: false,
    rate: 0,
    lifetime: CATCH_BURST_LIFETIME,
    maxParticles: 150,
    gravity: 0.3,
    blendMode: PBParticleSystem_BlendMode.PSB_ADD,
    shape: ParticleSystem.Shape.Sphere({ radius: 0.3 }),
    initialVelocitySpeed: { start: 3, end: 5 },
    initialSize: { start: 0.08, end: 0.18 },
    sizeOverTime: { start: 1, end: 0 },
    initialColor: {
      start: Color4.create(1, 0.9, 0.4, 1),
      end: Color4.create(1, 0.4, 0.1, 1)
    },
    colorOverTime: {
      start: Color4.create(1, 0.8, 0.5, 1),
      end: Color4.create(0.8, 0.2, 0, 0)
    },
    bursts: {
      values: [{ time: 0, count: 60, cycles: 1, interval: 0.01, probability: 1 }]
    }
  })
  timers.setTimeout(() => engine.removeEntity(burst), CATCH_BURST_CLEANUP_DELAY_MS)
}

// Which monster's art to paint onto the spawned prize's plane - same sprite-sheet cropping idea as
// the 2D UI (getUvsForPrizeQuadrant in ui.tsx), just expressed as glTF-style texture offset/tiling.
// Set once per startPrizeChase() call, reused by every hop.
export interface PrizeIcon {
  image: string
  gridCols: number
  gridRows: number
  localIndex: number // index within this image's own grid, not the global checkpoint slot
}

let currentIcon: PrizeIcon | null = null

// Size of the prize's billboard plane (metres) - matches a single sprite-sheet cell's aspect ratio
// (narrower than tall on prizes_01.png's 5x4 grid) scaled up 1.5x, validated against a standalone
// test plane before wiring it in here.
const PRIZE_PLANE_WIDTH = 1.2
const PRIZE_PLANE_HEIGHT = 1.5

// Crops currentIcon's grid cell onto the plane's material, with cutout alpha and matching emissive
// so the sprite reads clearly and glows in its own colors rather than relying on scene light.
function applyPrizeIcon(entity: Entity) {
  if (!currentIcon) return
  const { image, gridCols, gridRows, localIndex } = currentIcon
  const col = localIndex % gridCols
  const row = Math.floor(localIndex / gridCols)
  // The two renderers disagree on where V=0 sits. In the desktop Explorer it's the BOTTOM of the
  // texture, so row 0 (A1, the sheet's top row) has to be flipped to land on the right cell - the
  // same top-row flip the 2D UI's getUvsForPrizeQuadrant does. The mobile (Godot) renderer puts
  // V=0 at the TOP, so applying that flip there mirrors the sheet vertically: A1 lands on the
  // bottom row and every row is off. Only this axis differs; the column math is identical on both.
  const rowOffset = isMobile() ? row / gridRows : (gridRows - row - 1) / gridRows
  const iconTexture = Material.Texture.Common({
    src: image,
    offset: Vector2.create(col / gridCols, rowOffset),
    tiling: Vector2.create(1 / gridCols, 1 / gridRows)
  })
  Material.setPbrMaterial(entity, {
    texture: iconTexture,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_TEST,
    alphaTest: 0.5,
    emissiveTexture: iconTexture,
    emissiveColor: Color3.White(),
    emissiveIntensity: 1
  })
}

// Spawn-point markers placed in the Creator Hub (Transform + Name only, no visual - see
// assets/scene/main.composite). One is picked at random for each hop.
const PRIZE_MARKER_NAMES: string[] = [
  EntityNames.prize_1,
  EntityNames.prize_2,
  EntityNames.prize_3,
  EntityNames.prize_4,
  EntityNames.prize_5,
  EntityNames.prize_6,
  EntityNames.prize_7,
  EntityNames.prize_8,
  EntityNames.prize_9,
  EntityNames.prize_10,
  EntityNames.prize_11,
  EntityNames.prize_12
]

// Seconds the prize stays at one spawn point before hopping to another.
const HOP_DURATION = 5
// Total hops the player gets to catch it before the chase counts as failed.
export const PRIZE_CHASE_MAX_ATTEMPTS = 5
// Sphere trigger radius (metres) around the prize's current (bobbing) position - forgiving,
// coin-pickup feel rather than requiring a precise hit.
const CATCH_RADIUS = 1.5
// Markers closer than this to the player are skipped when picking a hop's location, so the prize
// never spawns inside (or right at the edge of) the catch radius and gets caught without the
// player having to actually move.
const MIN_SPAWN_DISTANCE_FROM_PLAYER = 4

// Metres above the marker's own height - was a 0-0.5 range (bottom edge sat at the marker's own
// height, half-buried in the ground for markers placed flush with the floor); lifted by 1m.
const BOB_MIN_HEIGHT = 1
const BOB_MAX_HEIGHT = 1.5
const BOB_LEG_DURATION_MS = 1200 // one-way (down->up or up->down) bob duration

let active = false
let hopElapsed = 0
let attempt = 0
let bobAnchor: Entity | null = null
let prizeModel: Entity | null = null
let lastMarkerName: string | null = null
let onCaughtCallback: (() => void) | null = null
let onFailedCallback: (() => void) | null = null
let onMissedCallback: (() => void) | null = null

function pickRandomMarkerName(): string {
  const playerPos = Transform.get(engine.PlayerEntity).position
  // Prefer markers far enough from the player and different from the last spot; fall back to just
  // "different from the last spot" (then to the full list) if that leaves nothing to pick from -
  // e.g. every marker happens to be close to the player right now.
  const farEnough = PRIZE_MARKER_NAMES.filter((name) => {
    const marker = engine.getEntityOrNullByName(name)
    if (!marker) return false
    return Vector3.distance(playerPos, getWorldPosition(marker)) >= MIN_SPAWN_DISTANCE_FROM_PLAYER
  })
  const notLastSpot = PRIZE_MARKER_NAMES.filter((name) => name !== lastMarkerName)
  const pool = farEnough.filter((name) => name !== lastMarkerName)
  const candidates = pool.length > 0 ? pool : farEnough.length > 0 ? farEnough : notLastSpot.length > 0 ? notLastSpot : PRIZE_MARKER_NAMES

  const name = candidates[Math.floor(Math.random() * candidates.length)]
  lastMarkerName = name
  return name
}

function despawnCurrentHop() {
  if (bobAnchor !== null) {
    triggerAreaEventsSystem.removeOnTriggerEnter(bobAnchor)
    engine.removeEntity(bobAnchor)
  }
  if (prizeModel !== null) engine.removeEntity(prizeModel)
  bobAnchor = null
  prizeModel = null
}

// TEMP (crash diagnosis): guarded because this runs as an SDK trigger callback, where a throw would
// take the whole scene down with no readable stack. See errorTrap.ts.
function handleCatch() {
  guard('prizeCatch', handleCatchInner)
}

function handleCatchInner() {
  if (!active) return
  active = false
  const onCaught = onCaughtCallback
  if (bobAnchor !== null) spawnCatchBurst(getWorldPosition(bobAnchor))
  despawnCurrentHop()
  onCaughtCallback = null
  onFailedCallback = null
  onMissedCallback = null
  onCaught?.()
}

function spawnHop() {
  despawnCurrentHop()
  attempt++

  const marker = engine.getEntityOrNullByName(pickRandomMarkerName())
  if (!marker) {
    console.error('[prizeChase] no prize_ marker entity found in the scene')
    return
  }

  const bobStart = Vector3.create(0, BOB_MIN_HEIGHT, 0)
  const bobEnd = Vector3.create(0, BOB_MAX_HEIGHT, 0)

  bobAnchor = engine.addEntity()
  Transform.create(bobAnchor, {
    parent: marker,
    position: bobStart,
    scale: Vector3.create(CATCH_RADIUS, CATCH_RADIUS, CATCH_RADIUS)
  })
  Tween.createOrReplace(bobAnchor, {
    duration: BOB_LEG_DURATION_MS,
    easingFunction: EasingFunction.EF_EASESINE,
    mode: Tween.Mode.Move({ start: bobStart, end: bobEnd })
  })
  TweenSequence.createOrReplace(bobAnchor, { sequence: [], loop: TweenLoop.TL_YOYO })
  TriggerArea.setSphere(bobAnchor)
  triggerAreaEventsSystem.onTriggerEnter(bobAnchor, handleCatch)

  prizeModel = engine.addEntity()
  Transform.create(prizeModel, { parent: bobAnchor, scale: Vector3.create(PRIZE_PLANE_WIDTH, PRIZE_PLANE_HEIGHT, 1) })
  MeshRenderer.setPlane(prizeModel)
  // BM_Y (not BM_ALL) - rotates to face the player around Y only, stays upright, cheaper to render.
  // Replaces the old continuous Y-spin: a billboard already always faces the player, so a spin
  // tween would just fight the billboard system for control of the same Transform.rotation.
  Billboard.create(prizeModel, { billboardMode: BillboardMode.BM_Y })
  applyPrizeIcon(prizeModel)

  hopElapsed = 0
}

// Spawns the first hop and starts the chase. icon selects which monster's art is painted onto the
// plane (see applyPrizeIcon). onCaught fires once the player touches the prize; onFailed fires if
// MAX_ATTEMPTS hops pass with no catch; onMissed fires each time a hop times out and a new one
// spawns (not on the very first hop). Exactly one of onCaught/onFailed fires, once.
export function startPrizeChase(icon: PrizeIcon, onCaught: () => void, onFailed: () => void, onMissed: () => void) {
  active = true
  attempt = 0
  lastMarkerName = null
  currentIcon = icon
  onCaughtCallback = onCaught
  onFailedCallback = onFailed
  onMissedCallback = onMissed
  spawnHop()
}

// Call every frame while a chase is active (the caller decides when that is).
export function updatePrizeChase(dt: number) {
  if (!active) return
  hopElapsed += dt
  if (hopElapsed < HOP_DURATION) return

  if (attempt >= PRIZE_CHASE_MAX_ATTEMPTS) {
    active = false
    const onFailed = onFailedCallback
    despawnCurrentHop()
    onCaughtCallback = null
    onFailedCallback = null
    onMissedCallback = null
    onFailed?.()
    return
  }

  onMissedCallback?.()
  spawnHop()
}

// Seconds left on the current hop (HOP_DURATION..0), for the UI countdown.
export function getPrizeChaseSecondsRemaining(): number {
  return Math.max(0, HOP_DURATION - hopElapsed)
}

// Chances left, counting the current hop (PRIZE_CHASE_MAX_ATTEMPTS..1), for "Chances: X/Y" copy.
export function getPrizeChaseChancesRemaining(): number {
  return Math.max(0, PRIZE_CHASE_MAX_ATTEMPTS - attempt + 1)
}

// Cancels an in-progress chase without firing either callback (e.g. the board was closed manually).
export function stopPrizeChase() {
  active = false
  onCaughtCallback = null
  onFailedCallback = null
  onMissedCallback = null
  despawnCurrentHop()
}
