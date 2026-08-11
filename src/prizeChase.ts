import {
  engine,
  Transform,
  GltfContainer,
  Tween,
  TweenSequence,
  TweenLoop,
  EasingFunction,
  TriggerArea,
  triggerAreaEventsSystem,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { EntityNames } from '../assets/scene/entity-names'

const PRIZE_MODEL = 'assets/models/prize_01.gltf'

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
export const PRIZE_CHASE_MAX_ATTEMPTS = 10
// Sphere trigger radius (metres) around the prize's current (bobbing) position - forgiving,
// coin-pickup feel rather than requiring a precise hit.
const CATCH_RADIUS = 1.5

const BOB_AMPLITUDE = 0.5 // metres up/down from the marker's own height
const BOB_LEG_DURATION_MS = 1200 // one-way (down->up or up->down) bob duration
const SPIN_DEGREES_PER_SECOND = 180 // full 360 rotation every 2s

let active = false
let hopElapsed = 0
let attempt = 0
let bobAnchor: Entity | null = null
let prizeModel: Entity | null = null
let lastMarkerName: string | null = null
let onCaughtCallback: (() => void) | null = null
let onFailedCallback: (() => void) | null = null

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

  const bobStart = Vector3.create(0, -BOB_AMPLITUDE, 0)
  const bobEnd = Vector3.create(0, BOB_AMPLITUDE, 0)

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
  Transform.create(prizeModel, { parent: bobAnchor })
  GltfContainer.create(prizeModel, { src: PRIZE_MODEL })
  Tween.setRotateContinuous(prizeModel, Quaternion.fromEulerDegrees(0, 1, 0), SPIN_DEGREES_PER_SECOND)

  hopElapsed = 0
}

// Spawns the first hop and starts the chase. onCaught fires once the player touches the prize;
// onFailed fires if MAX_ATTEMPTS hops pass with no catch. Exactly one of the two fires, once.
export function startPrizeChase(onCaught: () => void, onFailed: () => void) {
  active = true
  attempt = 0
  lastMarkerName = null
  onCaughtCallback = onCaught
  onFailedCallback = onFailed
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
    onFailed?.()
    return
  }

  spawnHop()
}

// Seconds left on the current hop (HOP_DURATION..0), for the UI countdown.
export function getPrizeChaseSecondsRemaining(): number {
  return Math.max(0, HOP_DURATION - hopElapsed)
}

// Current attempt number (1-indexed, PRIZE_CHASE_MAX_ATTEMPTS max), for the "Chance X/Y" UI copy.
export function getPrizeChaseAttempt(): number {
  return attempt
}

// Cancels an in-progress chase without firing either callback (e.g. the board was closed manually).
export function stopPrizeChase() {
  active = false
  onCaughtCallback = null
  onFailedCallback = null
  despawnCurrentHop()
}
