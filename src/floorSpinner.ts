import { engine, Transform, MeshRenderer, Material, MaterialTransparencyMode, type Entity } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { Vector2, Vector3, Quaternion, Color3 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'

// Loading-style ring shown at the player's feet while a checkpoint's boards are in play (see
// showPlayerFloorSpinner/updatePlayerFloorSpinner/hidePlayerFloorSpinner callers in ui.tsx). Same
// source art as the 2D loading spinner (ui.tsx's ALPHAS_IMAGE/SPINNER_BASE_UVS): A1-D4, the
// top-left quadrant of alphas.png's 8x8 grid - expressed here as a 2x2 super-grid so
// Material.Texture.Common's offset/tiling can crop it directly instead of rotating UVs.
const SPINNER_IMAGE = 'assets/images/alphas.png'
const SPINNER_ATLAS_QUADRANTS = 2
const SPINNER_PLANE_SIZE = 3 // metres
const SPINNER_FOOT_HEIGHT = -0.05 // just above ground, avoids z-fighting with the floor
const SPINNER_DEGREES_PER_SECOND = 180

// Two independent top-level entities instead of a parent+children hierarchy - no parentEntity()
// ordering to get right, just two Transforms this module writes directly every frame. Simpler to
// reason about for something that has to work across syncEntity without a live render to check.
let spinnerPlaneA: Entity | null = null
let spinnerPlaneB: Entity | null = null
let spinAngleDeg = 0

// Crops the spinner's quadrant onto the plane's material, with cutout alpha and matching emissive
// so it reads clearly and glows in its own colors. Row 0 (top row of the sheet): the desktop
// Explorer's V=0 is the texture's BOTTOM edge so the top row needs a 0.5 V offset, while the
// mobile (Godot) renderer's V=0 is the TOP edge so it needs none - same convention as
// prizeChase.ts's applyPrizeIcon.
function applySpinnerMaterial(entity: Entity) {
  const texture = Material.Texture.Common({
    src: SPINNER_IMAGE,
    offset: Vector2.create(0, isMobile() ? 0 : 1 / SPINNER_ATLAS_QUADRANTS),
    tiling: Vector2.create(1 / SPINNER_ATLAS_QUADRANTS, 1 / SPINNER_ATLAS_QUADRANTS)
  })
  Material.setPbrMaterial(entity, {
    texture,
    alphaTexture: texture,
    // ALPHA_TEST thresholds at 0.5 (fully opaque or fully discarded, no in-between), which flattens
    // the texture's soft alpha into a hard-edged cutout. ALPHA_BLEND reads the alpha channel as an
    // actual blend factor so partial-alpha pixels render partially transparent.
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    emissiveTexture: texture,
    emissiveColor: Color3.White(),
    emissiveIntensity: 1
  })
}

// A flat plane's front-face winding (which side is culled) isn't verified against this project's
// renderer without a live test, so two copies are laid down back-to-back (+90/-90 around X) -
// whichever winding convention is right, exactly one of them faces up and the other is invisible
// beneath the floor. Cheap insurance for a single 1x1 plane.
function spawnSpinnerPlane(): Entity {
  const plane = engine.addEntity()
  Transform.create(plane)
  MeshRenderer.setPlane(plane)
  applySpinnerMaterial(plane)
  // Every component another client needs to actually render this (position, mesh shape, material)
  // has to be listed here - only listed components get broadcast. No sync id: this is a
  // player-spawned entity, fine to be removed if its owner disconnects.
  syncEntity(plane, [Transform.componentId, MeshRenderer.componentId, Material.componentId])
  return plane
}

// Spin (world Y) composed with a fixed lie-flat tilt (local X) - applied in this order (spin *
// tilt) so the plane tilts flat first, then spins in place around the vertical axis, instead of
// tumbling around a tilted axis.
function planeRotation(tiltDeg: number): Quaternion {
  return Quaternion.multiply(Quaternion.fromEulerDegrees(0, spinAngleDeg, 0), Quaternion.fromEulerDegrees(tiltDeg, 0, 0))
}

// Other players in the scene need to see this too, which rules out `parent: engine.PlayerEntity` -
// that reserved entity means "whoever's own client this is", so it resolves to a DIFFERENT player
// on every viewer's own engine and can't be used to point at a specific other player. Instead each
// plane's world Transform is written every frame from this client's own player position
// (updatePlayerFloorSpinner) and broadcast via syncEntity, so every other client renders it at the
// real position.
export function showPlayerFloorSpinner() {
  if (spinnerPlaneA !== null) return
  spinAngleDeg = 0
  spinnerPlaneA = spawnSpinnerPlane()
  spinnerPlaneB = spawnSpinnerPlane()
  updatePlayerFloorSpinner(0) // place immediately instead of leaving it at the origin for a frame
}

// Call every frame while a checkpoint's boards are in play (see showPlayerFloorSpinner's callers in
// ui.tsx) - keeps both planes glued to this client's own feet and spinning; carried to other
// clients by the Transform sync set up in showPlayerFloorSpinner.
export function updatePlayerFloorSpinner(dt: number) {
  if (spinnerPlaneA === null || spinnerPlaneB === null) return
  spinAngleDeg = (spinAngleDeg + SPINNER_DEGREES_PER_SECOND * dt) % 360
  const playerPos = Transform.get(engine.PlayerEntity).position
  const position = Vector3.create(playerPos.x, playerPos.y + SPINNER_FOOT_HEIGHT, playerPos.z)
  const scale = Vector3.create(SPINNER_PLANE_SIZE, SPINNER_PLANE_SIZE, 1)

  const transformA = Transform.getMutable(spinnerPlaneA)
  transformA.position = position
  transformA.rotation = planeRotation(-90)
  transformA.scale = scale

  const transformB = Transform.getMutable(spinnerPlaneB)
  transformB.position = position
  transformB.rotation = planeRotation(90)
  transformB.scale = scale
}

export function hidePlayerFloorSpinner() {
  if (spinnerPlaneA !== null) engine.removeEntity(spinnerPlaneA)
  if (spinnerPlaneB !== null) engine.removeEntity(spinnerPlaneB)
  spinnerPlaneA = null
  spinnerPlaneB = null
}
