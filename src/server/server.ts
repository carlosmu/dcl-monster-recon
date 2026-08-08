import { engine } from '@dcl/sdk/ecs'
import { Storage } from '@dcl/sdk/server'
import { room } from '../shared/messages'
import checkpointsData from '../checkpoints.json'

const LEADERBOARD_KEY = 'leaderboard'
const LEADERBOARD_TOP_N = 10
const SERVER_TICK_INTERVAL = 1 // seconds between heartbeat broadcasts
const NO_BEST_TIME = -1
const TOTAL_CHECKPOINTS = checkpointsData.length
const PROGRESS_KEY = 'progress'

function bestTimeKey(checkpoint: number, boardIndex: number): string {
  return `bestTime-${checkpoint}-${boardIndex}`
}

interface LeaderboardEntry {
  playerName: string
  score: number
}

type LeaderboardMap = Record<string, LeaderboardEntry> // keyed by wallet address

interface PlayerProgress {
  highestUnlockedCheckpoint: number
  collectedMonsters: boolean[]
  collectionCounts: number[]
}

function defaultProgress(): PlayerProgress {
  return {
    highestUnlockedCheckpoint: 1,
    collectedMonsters: new Array(TOTAL_CHECKPOINTS).fill(false),
    collectionCounts: new Array(TOTAL_CHECKPOINTS).fill(0)
  }
}

// In-memory per-player progress, cached by the PROMISE (not just the resolved value) so
// back-to-back reportBoardTime calls for the same player (e.g. clearing checkpoints 1, 2, 3 in
// quick succession) all await the same in-flight fetch and mutate the same object, instead of
// each doing its own Storage.player.get and clobbering each other's writes on save - the read/set
// race that was dropping all but the last checkpoint completed in a burst.
const progressCache = new Map<string, Promise<PlayerProgress>>()

function getPlayerProgress(address: string): Promise<PlayerProgress> {
  let progress = progressCache.get(address)
  if (!progress) {
    progress = (async () => (await Storage.player.get<PlayerProgress>(address, PROGRESS_KEY)) ?? defaultProgress())()
    progressCache.set(address, progress)
  }
  return progress
}

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

    if (data.checkpointComplete) {
      const progress = await getPlayerProgress(context.from)
      progress.collectedMonsters[data.checkpoint - 1] = true
      progress.collectionCounts[data.checkpoint - 1] = (progress.collectionCounts[data.checkpoint - 1] ?? 0) + 1
      if (data.checkpoint === progress.highestUnlockedCheckpoint && progress.highestUnlockedCheckpoint < TOTAL_CHECKPOINTS) {
        progress.highestUnlockedCheckpoint++
      }
      await Storage.player.set(context.from, PROGRESS_KEY, progress)
      room.send('progressUpdate', progress, { to: [context.from] })
    }
  })

  room.onMessage('requestProgress', async (_data, context) => {
    if (!context) return
    const progress = await getPlayerProgress(context.from)
    room.send('progressUpdate', progress, { to: [context.from] })
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
