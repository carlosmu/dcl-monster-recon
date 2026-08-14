import { engine, Transform, MainCamera, VirtualCamera, InputModifier, type Entity } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { triggerEmote } from '~system/RestrictedActions'

// Celebration cinematic camera: orbits halfway (180°) around the player over this many seconds.
const CAM_DURATION = 3
const CAM_SWEEP_DEG = -360
// Elevated camera tilted down at the player, above head height, for a bird's-eye look.
const CAM_OFFSET = Vector3.create(0, 1.5, 3.5)
// The camera looks at this point (roughly chest height) instead of the parent's feet-level origin.
const LOOK_AT_OFFSET = Vector3.create(0, 1.5, 0)

// Predefined avatar emotes (disco, handsair, fistpump, cry) loop forever until replaced, so every
// trigger below is paired with an 'idle' emote once it has played through once (see updateEmote).
const EMOTE_DURATION = 3

let camParent: Entity
let camEntity: Entity
let lookAtEntity: Entity
let active = false
let elapsed = 0
let orbitStartAngleDeg = 0

let emoteActive = false
let emoteElapsed = 0

// Creates the celebration camera rig. Call once from setupUi().
export function setupCelebrationCamera() {
  camParent = engine.addEntity()
  Transform.create(camParent)

  lookAtEntity = engine.addEntity()
  Transform.create(lookAtEntity, { parent: camParent, position: LOOK_AT_OFFSET })

  camEntity = engine.addEntity()
  Transform.create(camEntity, { parent: camParent, position: CAM_OFFSET })
  VirtualCamera.create(camEntity, {
    lookAtEntity,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.5) }
  })
}

// Plays a celebration emote while the cinematic camera, parented at the player's position, sweeps
// 180° around them starting at startAngleDeg. Used both for the per-board score screen (hands air/
// disco, 0deg -> 180deg) and the monster-unlock screen (fist pump, 180deg -> 360deg).
export function triggerCelebrationCamera(predefinedEmote: string, startAngleDeg: number) {
  // The orbit is centered on a one-time position snapshot below, not tracked live - if the player
  // is still moving (e.g. just having run up to catch the scene prize) they'd visibly walk off-
  // center over the shot's duration, so movement is frozen for as long as the orbit is active.
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })

  const playerPos = Transform.get(engine.PlayerEntity).position
  Transform.getMutable(camParent).position = Vector3.clone(playerPos)
  Transform.getMutable(camParent).rotation = Quaternion.fromAngleAxis(startAngleDeg, Vector3.Up())
  elapsed = 0
  active = true
  orbitStartAngleDeg = startAngleDeg
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = camEntity
  startEmote(predefinedEmote)
}

// Advances the camera orbit; call every frame from the main system loop.
export function updateCelebrationCamera(dt: number) {
  updateEmote(dt)

  if (!active) return
  elapsed = Math.min(CAM_DURATION, elapsed + dt)
  const angleDeg = orbitStartAngleDeg + (elapsed / CAM_DURATION) * CAM_SWEEP_DEG
  Transform.getMutable(camParent).rotation = Quaternion.fromAngleAxis(angleDeg, Vector3.Up())
  if (elapsed >= CAM_DURATION) {
    active = false
    MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined
    InputModifier.deleteFrom(engine.PlayerEntity)
  }
}

// Plays when the player runs out of time and loses the board. No camera involved.
export function triggerDefeatEmote() {
  startEmote('cry')
}

function startEmote(predefinedEmote: string) {
  emoteElapsed = 0
  emoteActive = true
  void triggerEmote({ predefinedEmote })
}

// Ends the emote after one cycle, since predefined avatar emotes loop until replaced.
//
// Deliberately NOT stopEmote: that only exists in the SDK's typings and in the desktop Unity
// Explorer - the mobile (Godot) client doesn't expose it, so calling it there threw "stopEmote is
// not a function" and took the whole scene down ("SCENE ERROR") the first time a celebration emote
// finished. tsc can't catch that; the symbol is present at compile time and missing only at
// runtime. Triggering the predefined 'idle' emote overrides the looping one and goes through
// triggerEmote, which is proven to work on both clients.
function updateEmote(dt: number) {
  if (!emoteActive) return
  emoteElapsed += dt
  if (emoteElapsed >= EMOTE_DURATION) {
    emoteActive = false
    void triggerEmote({ predefinedEmote: 'idle' })
  }
}
