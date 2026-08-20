import { engine, Transform, MainCamera, VirtualCamera, InputModifier, timers, type Entity } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { triggerEmote, movePlayerTo } from '~system/RestrictedActions'

// Celebration cinematic camera: orbits halfway (180°) around the player over this many seconds.
const CAM_DURATION = 3
const CAM_SWEEP_DEG = -360
// Elevated camera tilted down at the player, above head height, for a bird's-eye look.
const CAM_OFFSET = Vector3.create(0, 1.5, 3.5)
// The camera looks at this point (roughly chest height) instead of the parent's feet-level origin.
const LOOK_AT_OFFSET = Vector3.create(0, 1.5, 0)

// The only emote ids the explorer knows. Anything else is accepted by triggerEmote and then fails
// to resolve to a clip client-side, which strands the avatar in "playing a scene emote" state -
// no emote wheel, no WASD, only a jump gets out of it (see startEmote).
const PREDEFINED_EMOTES = new Set([
  'wave', 'fistpump', 'robot', 'raiseHand', 'clap', 'money', 'kiss', 'tik', 'hammer', 'tektonik',
  'dontsee', 'handsair', 'shrug', 'disco', 'dab', 'headexplode', 'dance', 'snowfall', 'hohoho',
  'crafting', 'snowballhit', 'snowballthrow', 'cry', 'hands_in_the_air'
])

// A looping emote never stops on its own client-side (see startEmote's comment on why we don't
// fight the emote system directly). Instead, after this many seconds we nudge the player a tiny,
// imperceptible distance via movePlayerTo - movement is what makes the client end a scene emote,
// so a scripted micro-step does the same job as the player taking a real step themselves.
const EMOTE_LOOP_CUTOFF_SECONDS = 15
const EMOTE_LOOP_CUTOFF_NUDGE = 0.1

let camParent: Entity
let camEntity: Entity
let lookAtEntity: Entity
let active = false
let elapsed = 0
let orbitStartAngleDeg = 0
let emoteCutoffTimer: number | null = null

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
  // center over the shot's duration, so walking is frozen for as long as the orbit is active.
  //
  // Deliberately NOT disableAll: jumping is the client's built-in way to cancel an emote, and it's
  // the player's only escape hatch if anything goes wrong during the shot. Taking it away turns a
  // recoverable hiccup into a scene the player has to reload out of.
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableWalk: true, disableJog: true, disableRun: true })
  })

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
  if (!active) return
  elapsed = Math.min(CAM_DURATION, elapsed + dt)
  const angleDeg = orbitStartAngleDeg + (elapsed / CAM_DURATION) * CAM_SWEEP_DEG
  Transform.getMutable(camParent).rotation = Quaternion.fromAngleAxis(angleDeg, Vector3.Up())
  if (elapsed >= CAM_DURATION) {
    active = false
    MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined
    releaseInput()
  }
}

// Explicitly clearing every flag rather than only deleting the component: deleteFrom alone leaves
// nothing behind for the client to read as "restrictions lifted", so a frame where the delete is
// missed leaves the player frozen with no way to recover. Writing a fully-permissive modifier
// first makes the release unambiguous, and the delete then keeps the component pool clean.
// Exported so other input-freezing flows (e.g. tutorialChase.ts) can reuse the same unfreeze logic.
export function releaseInput() {
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({
      disableAll: false,
      disableWalk: false,
      disableJog: false,
      disableRun: false,
      disableJump: false,
      disableEmote: false,
      disableDoubleJump: false,
      disableGliding: false
    })
  })
  InputModifier.deleteFrom(engine.PlayerEntity)
}

// Plays when the player runs out of time and loses the board. No camera involved.
export function triggerDefeatEmote() {
  startEmote('cry')
}

// There is no way to stop an emote from a scene, and that is fine - the client ends one on its own
// as soon as the player moves or jumps. Every attempt to force an end here has made things worse:
//
//   1. stopEmote() only exists in the SDK typings, not in either shipping client, so calling it
//      threw "stopEmote is not a function" at runtime and took the whole scene down. tsc can't
//      catch that - the symbol is present at compile time and missing only at runtime.
//   2. Triggering a predefined 'idle' emote to override the looping one, which replaced (1), was
//      worse still: 'idle' is not one of the ids the explorer knows (see PREDEFINED_EMOTES). The
//      request is accepted, the avatar enters "playing a scene emote" state, and then the id never
//      resolves to a clip - so it never leaves that state. That is what left the player with a
//      dead emote wheel and dead WASD after every win and every loss, escapable only by jumping.
//
// So: trigger the emote and leave it alone - don't call stopEmote or another emote id to end it.
// The id is validated because an unknown one silently re-creates bug (2) rather than failing loudly.
// EMOTE_LOOP_CUTOFF_SECONDS below doesn't violate this: it ends the loop by moving the player, the
// same mechanism the client already uses when the player steps away on their own.
function startEmote(predefinedEmote: string) {
  if (!PREDEFINED_EMOTES.has(predefinedEmote)) {
    console.error(`celebration: '${predefinedEmote}' is not a predefined emote - skipping`)
    return
  }
  void triggerEmote({ predefinedEmote })

  if (emoteCutoffTimer !== null) timers.clearTimeout(emoteCutoffTimer)
  emoteCutoffTimer = timers.setTimeout(() => {
    emoteCutoffTimer = null
    const pos = Transform.get(engine.PlayerEntity).position
    void movePlayerTo({ newRelativePosition: Vector3.create(pos.x + EMOTE_LOOP_CUTOFF_NUDGE, pos.y, pos.z) })
  }, EMOTE_LOOP_CUTOFF_SECONDS * 1000)
}
