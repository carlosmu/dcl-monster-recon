import { executeTask } from '@dcl/sdk/ecs'

const FAILED = '__failed__'
const faceUrlByAddr = new Map<string, string | typeof FAILED>()
const inFlight = new Set<string>()

function normAddr(addr: string): string {
  return addr ? addr.toLowerCase() : ''
}

/** Resolved face texture URL, or `undefined` if still loading / failed / not a wallet. */
export function getLeaderboardFaceUrl(addr: string): string | undefined {
  const k = normAddr(addr)
  if (!k.startsWith('0x')) return undefined
  const v = faceUrlByAddr.get(k)
  if (v === FAILED) return undefined
  return v
}

/** Fire-and-forget profile fetches for leaderboard wallets (Decentraland lambdas). */
export function prefetchLeaderboardFaces(addresses: string[]) {
  for (const raw of addresses) {
    const k = normAddr(raw)
    if (!k.startsWith('0x')) continue
    if (faceUrlByAddr.has(k) || inFlight.has(k)) continue
    inFlight.add(k)
    executeTask(async () => {
      try {
        const res = await fetch(`https://peer.decentraland.org/lambdas/profiles/${k}`)
        if (!res.ok) throw new Error(String(res.status))
        const j = (await res.json()) as {
          avatars?: Array<{ avatar?: { snapshots?: { face256?: string; face128?: string } } }>
        }
        const face =
          j?.avatars?.[0]?.avatar?.snapshots?.face256 || j?.avatars?.[0]?.avatar?.snapshots?.face128
        if (typeof face === 'string' && face.startsWith('http')) {
          faceUrlByAddr.set(k, face)
        } else {
          faceUrlByAddr.set(k, FAILED)
        }
      } catch {
        faceUrlByAddr.set(k, FAILED)
      } finally {
        inFlight.delete(k)
      }
    })
  }
}
