import { engine } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'

// Full-screen image shown on scene start: holds fully opaque, then fades out and is removed.
const SPLASH_IMAGE = 'assets/images/thumbnail.png'
const SPLASH_HOLD_S = 2
const SPLASH_FADE_S = 2

let splashTime = 0
let splashDone = false

function splashSystem(dt: number) {
  splashTime += dt
  if (splashTime >= SPLASH_HOLD_S + SPLASH_FADE_S) {
    splashDone = true
    engine.removeSystem(splashSystem)
  }
}
engine.addSystem(splashSystem)

export const Splash = () => {
  if (splashDone) return null
  const alpha = 1 - Math.min(Math.max((splashTime - SPLASH_HOLD_S) / SPLASH_FADE_S, 0), 1)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 0, left: 0 },
        width: '100%',
        height: '100%'
      }}
      uiBackground={{
        textureMode: 'stretch',
        texture: { src: SPLASH_IMAGE },
        color: Color4.create(1, 1, 1, alpha)
      }}
    />
  )
}
