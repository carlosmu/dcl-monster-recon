import { engine, Transform, MainCamera, VirtualCamera, type Entity } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { triggerEmote } from '~system/RestrictedActions'

// Celebration cinematic camera: orbits halfway (180°) around the player over this many seconds.
const CAM_DURATION = 3
const CAM_SWEEP_DEG = 180
// Waist-height camera tilted up at the player for a heroic, low-angle look.
const CAM_OFFSET = Vector3.create(0, 0.2, 2.5)
// The camera looks at this point (above head height) instead of the parent's feet-level origin,
// so it tilts up dramatically rather than looking down at the player's feet.
const LOOK_AT_OFFSET = Vector3.create(0, 1.5, 0)

let camParent: Entity
let camEntity: Entity
let lookAtEntity: Entity
let active = false
let elapsed = 0
let orbitStartAngleDeg = 0

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
  const playerPos = Transform.get(engine.PlayerEntity).position
  Transform.getMutable(camParent).position = Vector3.clone(playerPos)
  Transform.getMutable(camParent).rotation = Quaternion.fromAngleAxis(startAngleDeg, Vector3.Up())
  elapsed = 0
  active = true
  orbitStartAngleDeg = startAngleDeg
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = camEntity
  void triggerEmote({ predefinedEmote })
}

// Advances the camera orbit; call every frame from the main system loop.
export function updateCelebrationCamera(dt: number) {
  if (!active) return
  elapsed = Math.min(CAM_DURATION, elapsed + dt)
  const angleDeg = orbitStartAngleDeg + (elapsed / CAM_DURATION) * CAM_SWEEP_DEG
  Transform.getMutable(camParent).rotation = Quaternion.fromAngleAxis(angleDeg, Vector3.Up())
  if (elapsed >= CAM_DURATION) {
    active = false
    MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined
  }
}

// Plays when the player runs out of time and loses the board. No camera involved.
export function triggerDefeatEmote() {
  void triggerEmote({ predefinedEmote: 'cry' })
}
