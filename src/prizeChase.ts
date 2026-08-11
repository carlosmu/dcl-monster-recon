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
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Vector2, Color3 } from '@dcl/sdk/math'
import { EntityNames } from '../assets/scene/entity-names'

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
  const iconTexture = Material.Texture.Common({
    src: image,
    // V=0 is the BOTTOM of the texture here (confirmed visually), so row 0 (A1, the sheet's top
    // row) needs the same top-row flip as the 2D UI's getUvsForPrizeQuadrant.
    offset: Vector2.create(col / gridCols, (gridRows - row - 1) / gridRows),
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
  let name = PRIZE_MARKER_NAMES[Math.floor(Math.random() * PRIZE_MARKER_NAMES.length)]
  while (name === lastMarkerName && PRIZE_MARKER_NAMES.length > 1) {
    name = PRIZE_MARKER_NAMES[Math.floor(Math.random() * PRIZE_MARKER_NAMES.length)]
  }
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

function handleCatch() {
  if (!active) return
  active = false
  const onCaught = onCaughtCallback
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
