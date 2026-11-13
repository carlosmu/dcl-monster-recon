import { InputAction, TouchScreenControls } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { setupUi } from './ui'

export async function main() {
  if (isServer()) {
    const { startServer } = await import('./server/server')
    await startServer()
    return
  }

  // Mobile: keep only the jump button. Hiding E, F, pointer (hand) and 1-4
  // also removes the "+" overflow toggle. No-op on desktop.
  TouchScreenControls.hide([
    InputAction.IA_POINTER,
    InputAction.IA_PRIMARY,
    InputAction.IA_SECONDARY,
    InputAction.IA_ACTION_3,
    InputAction.IA_ACTION_4,
    InputAction.IA_ACTION_5,
    InputAction.IA_ACTION_6
  ])

  setupUi()
}

