import { InputAction, engine, pointerEventsSystem } from '@dcl/sdk/ecs'
import { EntityNames } from '../assets/scene/entity-names'
import { setupUi, showCheckpointSelect } from './ui'

export function main() {
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

