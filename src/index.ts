import { InputAction, engine, pointerEventsSystem } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { EntityNames } from '../assets/scene/entity-names'
import { setupUi, showCheckpointSelect } from './ui'

export async function main() {
  if (isServer()) {
    const { startServer } = await import('./server/server')
    await startServer()
    return
  }

  setupUi()

  const buttonEntity = engine.getEntityOrNullByName(EntityNames.button)
  if (!buttonEntity) {
    console.error('Button entity not found')
    return
  }

  pointerEventsSystem.onPointerDown(
    {
      entity: buttonEntity,
      opts: { button: InputAction.IA_POINTER, hoverText: 'Play' }
    },
    () => {
      showCheckpointSelect()
    }
  )
}

