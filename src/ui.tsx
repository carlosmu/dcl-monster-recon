import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer } from '@dcl/sdk/react-ecs'

let showUi = false

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(uiMenu, { virtualWidth: 1920, virtualHeight: 1080 })
}

export function showHelloWorld() {
  showUi = true
  ReactEcsRenderer.setUiRenderer(uiMenu, { virtualWidth: 1920, virtualHeight: 1080 })
}

export const uiMenu = () => {
  if (!showUi) {
    return null
  }

  return ReactEcs.createElement(
    'uiEntity',
    {
      uiTransform: { width: '100%', height: '100%', positionType: 'absolute' },
      uiBackground: { color: Color4.create(0, 0, 0, 0.2) }
    },
    ReactEcs.createElement(
      'uiEntity',
      {
        uiTransform: {
          width: 600,
          height: 220,
          positionType: 'absolute',
          position: { top: '50%', left: '50%' },
          margin: { top: -110, left: -300 },
          justifyContent: 'center',
          alignItems: 'center'
        },
        uiBackground: { color: Color4.create(0, 0, 0, 0.85) }
      },
      ReactEcs.createElement('uiText', {
        value: 'hello world',
        fontSize: 48,
        color: Color4.White()
      })
    )
  )
}