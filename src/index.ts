import { isServer } from '@dcl/sdk/network'
import { setupUi } from './ui'

export async function main() {
  if (isServer()) {
    const { startServer } = await import('./server/server')
    await startServer()
    return
  }

  setupUi()
}

