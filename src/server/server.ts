import { engine } from '@dcl/sdk/ecs'
import { Storage } from '@dcl/sdk/server'
import { room } from '../shared/messages'
import checkpointsData from '../checkpoints.json'

// One leaderboard per week, each under its own key. Past weeks are simply never read again - they
// stay archived in storage for a future history screen or prize payout.
const LEADERBOARD_KEY_PREFIX = 'leaderboard-'
const LEADERBOARD_TOP_N = 10
const SERVER_TICK_INTERVAL = 1 // seconds between heartbeat broadcasts
const NO_BEST_TIME = -1
const TOTAL_CHECKPOINTS = checkpointsData.length
const PROGRESS_KEY = 'progress'

function bestTimeKey(checkpoint: number, boardIndex: number): string {
  return `bestTime-${checkpoint}-${boardIndex}`
}

// Identifies a week by the UTC date of its Monday (YYYY-MM-DD), so keys sort chronologically under
// LEADERBOARD_KEY_PREFIX and the week boundary is exactly Monday 00:00 UTC - the reset the
// leaderboard screen advertises.
function weekIdFor(timestamp: number): string {
  const date = new Date(timestamp)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7 // getUTCDay(): 0 = Sunday
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday)
  )
    .toISOString()
    .slice(0, 10)
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
  let currentWeekId = weekIdFor(Date.now())
  let leaderboard: LeaderboardMap = (await Storage.get<LeaderboardMap>(LEADERBOARD_KEY_PREFIX + currentWeekId)) ?? {}

  // Swaps in the new week's (empty, or whatever another instance already wrote) table once the clock
  // crosses Monday 00:00 UTC. currentWeekId is updated before the await so a second call from the
  // next tick returns early instead of racing this one.
  async function rolloverIfNeeded(): Promise<void> {
    const weekId = weekIdFor(Date.now())
    if (weekId === currentWeekId) return
    currentWeekId = weekId
    leaderboard = (await Storage.get<LeaderboardMap>(LEADERBOARD_KEY_PREFIX + weekId)) ?? {}
    broadcastLeaderboard(leaderboard, currentWeekId)
    console.log(`[Server] Leaderboard rolled over to week ${weekId}`)
  }

  room.onMessage('reportScore', async (data, context) => {
    if (!context) return
    await rolloverIfNeeded()
    const address = context.from
    const previousScore = leaderboard[address]?.score ?? 0
    leaderboard[address] = { playerName: data.playerName, score: previousScore + data.points }

    await Storage.set(LEADERBOARD_KEY_PREFIX + currentWeekId, leaderboard)
    broadcastLeaderboard(leaderboard, currentWeekId)
    console.log(`[Server] ${data.playerName} (${address}) +${data.points} pts -> ${leaderboard[address].score}`)
  })

  broadcastLeaderboard(leaderboard, currentWeekId)

  room.onMessage('requestLeaderboard', (_data, context) => {
    if (!context) return
    broadcastLeaderboard(leaderboard, currentWeekId, [context.from])
  })

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

  room.onMessage('reportMonsterCaught', async (data, context) => {
    if (!context) return
    const progress = await getPlayerProgress(context.from)
    progress.collectedMonsters[data.checkpoint - 1] = true
    progress.collectionCounts[data.checkpoint - 1] = (progress.collectionCounts[data.checkpoint - 1] ?? 0) + 1
    if (data.checkpoint === progress.highestUnlockedCheckpoint && progress.highestUnlockedCheckpoint < TOTAL_CHECKPOINTS) {
      progress.highestUnlockedCheckpoint++
    }
    await Storage.player.set(context.from, PROGRESS_KEY, progress)
    room.send('progressUpdate', progress, { to: [context.from] })
  })

  room.onMessage('requestProgress', async (_data, context) => {
    if (!context) return
    const progress = await getPlayerProgress(context.from)
    room.send('progressUpdate', progress, { to: [context.from] })
  })

  // TEMP (duration calibration): dumps every bestTime-* key for the caller. Remove once
  // checkpoints.json durations have been recalibrated from a real playthrough.
  room.onMessage('requestAllBestTimes', async (_data, context) => {
    if (!context) return
    const { data } = await Storage.player.getValues(context.from, { prefix: 'bestTime-', limit: 200 })
    const entries = data.map(({ key, value }) => ({ key, seconds: value as number }))
    room.send('allBestTimesUpdate', { entries }, { to: [context.from] })
  })

  let tick = 0
  let sinceLastTick = 0
  engine.addSystem((dt: number) => {
    sinceLastTick += dt
    if (sinceLastTick >= SERVER_TICK_INTERVAL) {
      sinceLastTick = 0
      tick++
      room.send('serverTick', { tick })
      // Rolls the week over on an idle room too, so players sitting in the scene across Monday
      // 00:00 UTC see the table clear instead of a stale one.
      void rolloverIfNeeded()
    }
  })
}

function broadcastLeaderboard(leaderboard: LeaderboardMap, weekId: string, to?: string[]) {
  const entries = Object.entries(leaderboard)
    .map(([address, entry]) => ({ ...entry, address }))
    .sort((a, b) => b.score - a.score)
    .slice(0, LEADERBOARD_TOP_N)
  room.send('leaderboardUpdate', { weekId, entries }, to ? { to } : undefined)
}
