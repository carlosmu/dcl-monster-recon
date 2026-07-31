import { engine } from '@dcl/sdk/ecs'
import { Storage } from '@dcl/sdk/server'
import { room } from '../shared/messages'

const LEADERBOARD_KEY = 'leaderboard'
const LEADERBOARD_TOP_N = 10
const SERVER_TICK_INTERVAL = 1 // seconds between heartbeat broadcasts
const NO_BEST_TIME = -1

function bestTimeKey(checkpoint: number, boardIndex: number): string {
  return `bestTime-${checkpoint}-${boardIndex}`
}

interface LeaderboardEntry {
  playerName: string
  score: number
}

type LeaderboardMap = Record<string, LeaderboardEntry> // keyed by wallet address

export async function startServer() {
  let leaderboard: LeaderboardMap = (await Storage.get<LeaderboardMap>(LEADERBOARD_KEY)) ?? {}

  room.onMessage('reportScore', async (data, context) => {
    if (!context) return
    const address = context.from
    const previousScore = leaderboard[address]?.score ?? 0
    leaderboard[address] = { playerName: data.playerName, score: previousScore + data.points }

    await Storage.set(LEADERBOARD_KEY, leaderboard)
    broadcastLeaderboard(leaderboard)
    console.log(`[Server] ${data.playerName} (${address}) +${data.points} pts -> ${leaderboard[address].score}`)
  })

  broadcastLeaderboard(leaderboard)

  room.onMessage('requestBestTime', async (data, context) => {
    if (!context) return
    const key = bestTimeKey(data.checkpoint, data.boardIndex)
    const best = await Storage.player.get<number>(context.from, key)
    room.send(
      'personalBestUpdate',
      { checkpoint: data.checkpoint, boardIndex: data.boardIndex, bestTimeSeconds: best ?? NO_BEST_TIME },
      { to: [context.from] }
    )
  })

  room.onMessage('reportBoardTime', async (data, context) => {
    if (!context) return
    const key = bestTimeKey(data.checkpoint, data.boardIndex)
    const current = await Storage.player.get<number>(context.from, key)
    const best = current === null || data.timeSeconds < current ? data.timeSeconds : current
    if (best !== current) await Storage.player.set(context.from, key, best)
    room.send(
      'personalBestUpdate',
      { checkpoint: data.checkpoint, boardIndex: data.boardIndex, bestTimeSeconds: best },
      { to: [context.from] }
    )
  })

  let tick = 0
  let sinceLastTick = 0
  engine.addSystem((dt: number) => {
    sinceLastTick += dt
    if (sinceLastTick >= SERVER_TICK_INTERVAL) {
      sinceLastTick = 0
      tick++
      room.send('serverTick', { tick })
    }
  })
}

function broadcastLeaderboard(leaderboard: LeaderboardMap) {
  const entries = Object.values(leaderboard)
    .sort((a, b) => b.score - a.score)
    .slice(0, LEADERBOARD_TOP_N)
  room.send('leaderboardUpdate', { entries })
}
