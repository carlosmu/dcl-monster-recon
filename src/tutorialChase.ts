import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Billboard,
  BillboardMode,
  VirtualCamera,
  MainCamera,
  InputModifier,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Vector2, Color3, Quaternion } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { getWorldPosition } from '@dcl-sdk/utils'
import { movePlayerTo } from '~system/RestrictedActions'
import { EntityNames } from '../assets/scene/entity-names'
import { releaseInput } from './celebration'
import { DEBUG_FREEZE_TUTORIAL_CHASE } from './debugFlags'

// One-time-per-catch tutorial cinematic: plays whenever checkpoint 1's 3 boards are completed, to
// teach first-time players the "find and touch the monster" mechanic. All at once: rotates the
// player to face the scene center, spawns the monster a fixed distance in front of them (instead
// of a random marker - see prizeChase.ts's tutorialFirstHopPosition param), cuts to an
// over-the-shoulder cinematic camera with letterbox bars (bars are 2D UI, rendered by ui.tsx off
// isTutorialCinematicActive), and drops a floating arrow over the monster. Everything reverts on
// its own after TUTORIAL_CINEMATIC_DURATION - the chase itself (already started by the caller)
// keeps running underneath and continues normally once control is handed back.

const TUTORIAL_CINEMATIC_DURATION = 6 // seconds - camera/bars/arrow all share this one window
const MONSTER_DISTANCE_FROM_PLAYER = 3 // metres, along the player's new forward (toward camp.gltf)

// Over-the-shoulder rig: 2m behind the player, shifted 1m to their right, at roughly head height -
// expressed in the player's own local space, then rotated into world space by facingRotation below.
const CAM_LOCAL_OFFSET = Vector3.create(1, 1.6, -2)

// Monster dialog plane: a child of the monster's own bob anchor (see attachMonsterDialog below), so
// it inherits the bobbing Tween for free instead of needing its own position tracking. Always faces
// the camera via Billboard(BM_Y) - no manual tilt on top of that (BM_Y recomputes rotation every
// frame, so any extra Z/X tilt set on the entity gets silently discarded - earlier attempts at a
// diagonal roll never visibly turned because of this). Matches the actual art at G4:H5 (a roughly
// square "CATCH ME!" speech bubble, 2 cols x 2 rows) - see MONSTER_DIALOG_UV_* below.
const MONSTER_DIALOG_WIDTH = 1
const MONSTER_DIALOG_HEIGHT = 1
// Local offset from the bob anchor - per debug positioning pass. Note this is now in the anchor's
// own local space, which is itself scaled by CATCH_RADIUS (see prizeChase.ts) - same as the prize
// icon plane already deals with, so the effective world offset is these values x CATCH_RADIUS.
const MONSTER_DIALOG_OFFSET_Y = 0.7
const MONSTER_DIALOG_OFFSET_Z = 0.7
const MONSTER_DIALOG_IMAGE = 'assets/images/atlas_02.png'
// atlas_02.png G4:H5 - same 8x8 grid convention used for this atlas elsewhere (see ui.tsx's
// BACK_ATLAS_GRID). Column G = index 6, spanning 2 columns (G-H); row 4 = index 3, spanning 2 rows.
const MONSTER_DIALOG_UVS_GRID = 8
const MONSTER_DIALOG_UV_COL = 6
const MONSTER_DIALOG_UV_ROW = 3
const MONSTER_DIALOG_UV_COL_SPAN = 2
const MONSTER_DIALOG_UV_ROW_SPAN = 2
const MONSTER_DIALOG_EMISSIVE_INTENSITY = 1

let camEntity: Entity
// Recreated per attachMonsterDialog() call (see there) rather than a single persistent entity: it's
// parented to the monster's bob anchor, which prizeChase.ts destroys and recreates on every hop, so
// a stale reference to a removed entity would crash the next Transform.getMutable call.
let monsterDialogEntity: Entity | null = null
let active = false
let elapsed = 0

function getCampWorldPosition(): Vector3 | null {
  const campEntity = engine.getEntityOrNullByName(EntityNames.camp_gltf)
  return campEntity ? getWorldPosition(campEntity) : null
}

// Creates the cinematic camera. Call once from setupUi(). The monster dialog plane is created later,
// per chase, by attachMonsterDialog() - see the comment on monsterDialogEntity above.
export function setupTutorialChase() {
  camEntity = engine.addEntity()
  Transform.create(camEntity)
  VirtualCamera.create(camEntity, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.3) }
  })
}

// Same top-row V-flip split as applyPrizeIcon in prizeChase.ts: the desktop Explorer and the mobile
// (Godot) renderer disagree on which end of the texture V=0 sits at. Generalized here for a
// multi-row span (applyPrizeIcon only ever crops a single grid cell).
function buildMonsterDialogMaterial() {
  const rowOffset = isMobile()
    ? MONSTER_DIALOG_UV_ROW / MONSTER_DIALOG_UVS_GRID
    : (MONSTER_DIALOG_UVS_GRID - MONSTER_DIALOG_UV_ROW - MONSTER_DIALOG_UV_ROW_SPAN) / MONSTER_DIALOG_UVS_GRID
  const texture = Material.Texture.Common({
    src: MONSTER_DIALOG_IMAGE,
    offset: Vector2.create(MONSTER_DIALOG_UV_COL / MONSTER_DIALOG_UVS_GRID, rowOffset),
    tiling: Vector2.create(MONSTER_DIALOG_UV_COL_SPAN / MONSTER_DIALOG_UVS_GRID, MONSTER_DIALOG_UV_ROW_SPAN / MONSTER_DIALOG_UVS_GRID)
  })
  return {
    texture,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_TEST,
    alphaTest: 0.5,
    emissiveTexture: texture,
    emissiveColor: Color3.White(),
    emissiveIntensity: MONSTER_DIALOG_EMISSIVE_INTENSITY
  }
}

// Spawns the "monster_dialog" plane as a child of monsterEntity (the monster's bob anchor - see
// prizeChase.ts's getCurrentBobAnchor), so it inherits that anchor's bobbing Tween instead of
// needing to track the monster's position itself. Replaces any previous instance.
export function attachMonsterDialog(monsterEntity: Entity) {
  if (monsterDialogEntity !== null) engine.removeEntity(monsterDialogEntity)

  monsterDialogEntity = engine.addEntity()
  Transform.create(monsterDialogEntity, {
    parent: monsterEntity,
    position: Vector3.create(0, MONSTER_DIALOG_OFFSET_Y, MONSTER_DIALOG_OFFSET_Z),
    scale: Vector3.create(MONSTER_DIALOG_WIDTH, MONSTER_DIALOG_HEIGHT, 1)
  })
  MeshRenderer.setPlane(monsterDialogEntity)
  // Tracks the camera as the player turns, instead of the fixed 90/-90 Y guess tried earlier - that
  // only ever looked right from one direction, which is exactly the "no funciona si me giro" bug.
  Billboard.create(monsterDialogEntity, { billboardMode: BillboardMode.BM_Y })
  Material.setPbrMaterial(monsterDialogEntity, buildMonsterDialogMaterial())
}

// Rotates the player to face camp.gltf, positions the cinematic camera, and freezes movement for
// the duration. Returns a monster spot MONSTER_DISTANCE_FROM_PLAYER ahead of that new facing, for
// the caller to pass into startPrizeChase's tutorialFirstHopPosition - once that spawns the monster's
// bob anchor, the caller must also call attachMonsterDialog(anchor) separately (this function alone
// doesn't touch the dialog plane, since that anchor doesn't exist yet at this point). Returns null if
// camp.gltf isn't in the scene, in which case nothing else here runs either.
export function startTutorialCinematic(): Vector3 | null {
  const campPos = getCampWorldPosition()
  if (!campPos) {
    console.error('[tutorialChase] camp.gltf not found in scene - skipping tutorial cinematic')
    return null
  }

  const playerPos = Transform.get(engine.PlayerEntity).position
  const forward = Vector3.normalize(Vector3.create(campPos.x - playerPos.x, 0, campPos.z - playerPos.z))
  const facingRotation = Quaternion.lookRotation(forward)
  const monsterSpawnPos = Vector3.add(playerPos, Vector3.scale(forward, MONSTER_DISTANCE_FROM_PLAYER))

  // avatarTarget rotates the avatar to face campPos without moving it (newRelativePosition is the
  // player's own current spot).
  void movePlayerTo({ newRelativePosition: Vector3.clone(playerPos), avatarTarget: campPos })

  if (DEBUG_FREEZE_TUTORIAL_CHASE) {
    // Debug positioning mode: skip the timed camera/letterbox-bars/input-freeze entirely, leaving
    // the normal free-look camera so the monster + dialog can be checked from any angle. The dialog
    // stays attached indefinitely since updateTutorialChase never runs its auto-remove (active stays
    // false); the monster stays put too, since its hop timer only advances while the "find the
    // monster" toast is showing, which this debug path never triggers.
    active = false
    return monsterSpawnPos
  }

  // Same partial freeze as celebration.ts's triggerCelebrationCamera: walking is locked so the
  // player doesn't wander out of frame, but jumping is deliberately left alone as an escape hatch.
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableWalk: true, disableJog: true, disableRun: true })
  })

  Transform.getMutable(camEntity).position = Vector3.add(playerPos, Vector3.rotate(CAM_LOCAL_OFFSET, facingRotation))
  Transform.getMutable(camEntity).rotation = facingRotation
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = camEntity

  elapsed = 0
  active = true
  return monsterSpawnPos
}

// Advances the cinematic timer; call every frame from the main system loop. Hands control back
// (camera, bars, dialog plane, input) once TUTORIAL_CINEMATIC_DURATION elapses - the chase
// underneath just keeps going with its normal timer/hop behavior. Removing (not hiding) the dialog
// plane here, well before hopDuration can ever elapse and despawn the bob anchor it's parented to,
// is what keeps monsterDialogEntity from ever pointing at an already-removed entity.
export function updateTutorialChase(dt: number) {
  if (!active) return
  elapsed += dt
  if (elapsed < TUTORIAL_CINEMATIC_DURATION) return

  active = false
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined
  if (monsterDialogEntity !== null) {
    engine.removeEntity(monsterDialogEntity)
    monsterDialogEntity = null
  }
  releaseInput()
}

// Drives the 2D letterbox bars in ui.tsx - they share this exact same window.
export function isTutorialCinematicActive(): boolean {
  return active
}
