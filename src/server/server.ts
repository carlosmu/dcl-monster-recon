import { engine } from '@dcl/sdk/ecs'
import { Storage } from '@dcl/sdk/server'
import { room } from '../shared/messages'
import checkpointsData from '../checkpoints.json'
// TEMP (carlosmu.dcl.eth -> monsterrecon.dcl.eth migration): snapshot pulled from carlosmu.dcl.eth
// via requestBackup, replayed into this world's storage by requestRestore below. Remove this
// import, migrationSnapshot.json, and the requestRestore handler once the migration is confirmed.
import migrationSnapshotJson from './migrationSnapshot.json'

// One leaderboard per week, each under its own key. Past weeks are simply never read again - they
// stay archived in storage for a future history screen or prize payout.
const LEADERBOARD_KEY_PREFIX = 'leaderboard-'
const LEADERBOARD_TOP_N = 10
// Running per-wallet total across every week, never reset. Deliberately outside the
// LEADERBOARD_KEY_PREFIX namespace so it isn't picked up by the weekly prefix scans below
// (backfillAllTime's own scan, requestBackup's).
const ALL_TIME_KEY = 'alltime-leaderboard'
const SERVER_TICK_INTERVAL = 1 // seconds between heartbeat broadcasts
const NO_BEST_TIME = -1
const TOTAL_CHECKPOINTS = checkpointsData.length
const PROGRESS_KEY = 'progress'
const BEST_TIME_KEY_PREFIX = 'bestTime-'
// Same wallet listed in scene.json's logsPermissions - only this address may trigger requestBackup.
const OWNER_ADDRESS = '0x4B538E1E044922aec2F428EC7E17A99f44205fF9'
// Every wallet the server has ever seen a message from, so requestBackup knows whose player
// storage to dump (player storage has no "list all addresses" API). Persisted under this key so
// the list survives a server restart.
const KNOWN_PLAYERS_KEY = 'known-players'

function bestTimeKey(checkpoint: number, boardIndex: number): string {
  return `${BEST_TIME_KEY_PREFIX}${checkpoint}-${boardIndex}`
}

// Reset happens at 10:00 UTC rather than midnight so it doesn't cut off night-owl EU players or
// hit NA players mid-Sunday-evening.
const WEEK_RESET_HOUR_UTC = 10

// Identifies a week by the UTC date of its Monday (YYYY-MM-DD), so keys sort chronologically under
// LEADERBOARD_KEY_PREFIX and the week boundary is exactly Monday 10:00 UTC - the reset the
// leaderboard screen advertises.
function weekIdFor(timestamp: number): string {
  const date = new Date(timestamp - WEEK_RESET_HOUR_UTC * 60 * 60 * 1000)
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

interface MigrationSnapshot {
  leaderboards: Record<string, LeaderboardMap>
  players: Record<string, { progress: PlayerProgress; bestTimes: Record<string, number> }>
}

const migrationSnapshot = migrationSnapshotJson as unknown as MigrationSnapshot

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

// In-memory mirror of KNOWN_PLAYERS_KEY, cached by PROMISE (same reasoning as progressCache above)
// so back-to-back messages from players not yet loaded all await the same in-flight read instead of
// each writing their own partial view back and clobbering one another.
let knownPlayers: Promise<Set<string>> | null = null

function trackPlayer(address: string): void {
  void (async () => {
    if (!knownPlayers) {
      knownPlayers = (async () => new Set(((await Storage.get<string[]>(KNOWN_PLAYERS_KEY)) ?? [])))()
    }
    const players = await knownPlayers
    if (players.has(address)) return
    players.add(address)
    await Storage.set(KNOWN_PLAYERS_KEY, [...players])
  })()
}

// Builds the initial all-time total by summing every archived weekly leaderboard (including
// migrated weeks) the first time ALL_TIME_KEY doesn't exist yet - after that it's only ever
// incremented directly by reportScore, never recomputed from the weeks again.
async function backfillAllTime(): Promise<LeaderboardMap> {
  const allTime: LeaderboardMap = {}
  let offset = 0
  for (;;) {
    const { data, pagination } = await Storage.getValues({ prefix: LEADERBOARD_KEY_PREFIX, limit: 100, offset })
    for (const { value } of data) {
      for (const [address, entry] of Object.entries(value as LeaderboardMap)) {
        allTime[address] = { playerName: entry.playerName, score: (allTime[address]?.score ?? 0) + entry.score }
      }
    }
    offset += data.length
    if (data.length === 0 || offset >= pagination.total) break
  }
  await Storage.set(ALL_TIME_KEY, allTime)
  console.log(`[Server] All-time leaderboard backfilled from ${offset} week(s), ${Object.keys(allTime).length} player(s)`)
  return allTime
}

export async function startServer() {
  let currentWeekId = weekIdFor(Date.now())
  let leaderboard: LeaderboardMap = (await Storage.get<LeaderboardMap>(LEADERBOARD_KEY_PREFIX + currentWeekId)) ?? {}
  let allTime: LeaderboardMap = (await Storage.get<LeaderboardMap>(ALL_TIME_KEY)) ?? (await backfillAllTime())

  // Swaps in the new week's (empty, or whatever another instance already wrote) table once the clock
  // crosses Monday 10:00 UTC. currentWeekId is updated before the await so a second call from the
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
    trackPlayer(context.from)
    await rolloverIfNeeded()
    const address = context.from
    const previousScore = leaderboard[address]?.score ?? 0
    leaderboard[address] = { playerName: data.playerName, score: previousScore + data.points }
    const previousAllTimeScore = allTime[address]?.score ?? 0
    allTime[address] = { playerName: data.playerName, score: previousAllTimeScore + data.points }

    await Storage.set(LEADERBOARD_KEY_PREFIX + currentWeekId, leaderboard)
    await Storage.set(ALL_TIME_KEY, allTime)
    broadcastLeaderboard(leaderboard, currentWeekId)
    broadcastAllTimeLeaderboard(allTime)
    room.send('playerNotification', { playerName: data.playerName, address, kind: 'points', amount: data.points, checkpoint: 0 })
    console.log(`[Server] ${data.playerName} (${address}) +${data.points} pts -> ${leaderboard[address].score} (all-time ${allTime[address].score})`)
  })

  broadcastLeaderboard(leaderboard, currentWeekId)
  broadcastAllTimeLeaderboard(allTime)

  room.onMessage('requestLeaderboard', (_data, context) => {
    if (!context) return
    trackPlayer(context.from)
    broadcastLeaderboard(leaderboard, currentWeekId, [context.from])
    broadcastAllTimeLeaderboard(allTime, [context.from])
  })

  room.onMessage('requestMyScore', async (_data, context) => {
    if (!context) return
    trackPlayer(context.from)
    await rolloverIfNeeded()
    room.send('myScoreUpdate', { score: leaderboard[context.from]?.score ?? 0 }, { to: [context.from] })
  })

  room.onMessage('requestBestTime', async (data, context) => {
    if (!context) return
    trackPlayer(context.from)
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
    trackPlayer(context.from)
    const key = bestTimeKey(data.checkpoint, data.boardIndex)
    const current = await Storage.player.get<number>(context.from, key)
    // Only a strictly better time than an existing record counts as "new best" - the very first
    // clear of a board always has current === null, so it doesn't fire a notification.
    const isNewBest = current !== null && data.timeSeconds < current
    const best = current === null || data.timeSeconds < current ? data.timeSeconds : current
    if (best !== current) await Storage.player.set(context.from, key, best)
    room.send(
      'personalBestUpdate',
      { checkpoint: data.checkpoint, boardIndex: data.boardIndex, bestTimeSeconds: best },
      { to: [context.from] }
    )
    if (isNewBest) {
      room.send('playerNotification', { playerName: data.playerName, address: context.from, kind: 'bestTime', amount: 0, checkpoint: 0 })
    }
  })

  room.onMessage('reportMonsterCaught', async (data, context) => {
    if (!context) return
    trackPlayer(context.from)
    const progress = await getPlayerProgress(context.from)
    progress.collectedMonsters[data.checkpoint - 1] = true
    progress.collectionCounts[data.checkpoint - 1] = (progress.collectionCounts[data.checkpoint - 1] ?? 0) + 1
    if (data.checkpoint === progress.highestUnlockedCheckpoint && progress.highestUnlockedCheckpoint < TOTAL_CHECKPOINTS) {
      progress.highestUnlockedCheckpoint++
    }
    await Storage.player.set(context.from, PROGRESS_KEY, progress)
    room.send('progressUpdate', progress, { to: [context.from] })
    room.send('playerNotification', { playerName: data.playerName, address: context.from, kind: 'captured', amount: 0, checkpoint: data.checkpoint })
  })

  room.onMessage('requestProgress', async (_data, context) => {
    if (!context) return
    trackPlayer(context.from)
    const progress = await getPlayerProgress(context.from)
    room.send('progressUpdate', progress, { to: [context.from] })
  })

  // TEMP (duration calibration): dumps every bestTime-* key for the caller. Remove once
  // checkpoints.json durations have been recalibrated from a real playthrough.
  room.onMessage('requestAllBestTimes', async (_data, context) => {
    if (!context) return
    const { data } = await Storage.player.getValues(context.from, { prefix: BEST_TIME_KEY_PREFIX, limit: 200 })
    const entries = data.map(({ key, value }) => ({ key, seconds: value as number }))
    room.send('allBestTimesUpdate', { entries }, { to: [context.from] })
  })

  // Owner-only: consolidates every leaderboard week and every known player's progress/best-times
  // into one dated snapshot key, so the whole dataset can be pulled with a single
  // `sdk-commands storage scene get backup-<key>` instead of enumerating keys by hand.
  room.onMessage('requestBackup', async (_data, context) => {
    if (!context || context.from.toLowerCase() !== OWNER_ADDRESS.toLowerCase()) return

    const leaderboards: Record<string, LeaderboardMap> = {}
    let offset = 0
    for (;;) {
      const { data, pagination } = await Storage.getValues({ prefix: LEADERBOARD_KEY_PREFIX, limit: 100, offset })
      for (const { key, value } of data) leaderboards[key] = value as LeaderboardMap
      offset += data.length
      if (data.length === 0 || offset >= pagination.total) break
    }

    const players: Record<string, { progress: PlayerProgress; bestTimes: Record<string, number> }> = {}
    const knownAddresses = await (knownPlayers ?? Promise.resolve(new Set<string>()))
    for (const address of knownAddresses) {
      const progress = (await Storage.player.get<PlayerProgress>(address, PROGRESS_KEY)) ?? defaultProgress()
      const { data: bestTimeEntries } = await Storage.player.getValues(address, { prefix: BEST_TIME_KEY_PREFIX, limit: 200 })
      const bestTimes: Record<string, number> = {}
      for (const { key, value } of bestTimeEntries) bestTimes[key] = value as number
      players[address] = { progress, bestTimes }
    }

    const snapshotKey = `backup-${Date.now()}`
    await Storage.set(snapshotKey, { generatedAt: Date.now(), leaderboards, players })
    console.log(
      `[Server] Backup snapshot '${snapshotKey}': ${Object.keys(leaderboards).length} leaderboard week(s), ${Object.keys(players).length} player(s)`
    )
    room.send('backupComplete', { snapshotKey, playerCount: Object.keys(players).length }, { to: [context.from] })
  })

  // TEMP (migration): owner-only, writes migrationSnapshot's leaderboard/player data into this
  // world's storage via real Storage.set/Storage.player.set calls (the CLI can only set one key at
  // a time). Remove this handler, requestRestore/restoreComplete in messages.ts, and
  // migrationSnapshot.json once the migration is confirmed.
  room.onMessage('requestRestore', async (_data, context) => {
    if (!context || context.from.toLowerCase() !== OWNER_ADDRESS.toLowerCase()) return

    const addresses = new Set<string>()

    for (const [key, value] of Object.entries(migrationSnapshot.leaderboards)) {
      await Storage.set(key, value)
      for (const address of Object.keys(value)) addresses.add(address)
      // Refresh the in-memory leaderboard the running server already loaded for the current week,
      // so it shows up immediately instead of waiting for the next rollover/restart.
      if (key === LEADERBOARD_KEY_PREFIX + currentWeekId) {
        leaderboard = value
        broadcastLeaderboard(leaderboard, currentWeekId)
      }
    }

    for (const [address, { progress, bestTimes }] of Object.entries(migrationSnapshot.players)) {
      await Storage.player.set(address, PROGRESS_KEY, progress)
      for (const [key, seconds] of Object.entries(bestTimes)) {
        await Storage.player.set(address, key, seconds)
      }
      progressCache.set(address, Promise.resolve(progress))
      addresses.add(address)
    }

    if (!knownPlayers) {
      knownPlayers = (async () => new Set(((await Storage.get<string[]>(KNOWN_PLAYERS_KEY)) ?? [])))()
    }
    const players = await knownPlayers
    for (const address of addresses) players.add(address)
    await Storage.set(KNOWN_PLAYERS_KEY, [...players])

    const leaderboardCount = Object.keys(migrationSnapshot.leaderboards).length
    const playerCount = Object.keys(migrationSnapshot.players).length
    console.log(`[Server] Restore complete: ${leaderboardCount} leaderboard week(s), ${playerCount} player(s)`)
    room.send('restoreComplete', { leaderboardCount, playerCount }, { to: [context.from] })
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
      // 10:00 UTC see the table clear instead of a stale one.
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

function broadcastAllTimeLeaderboard(allTime: LeaderboardMap, to?: string[]) {
  const entries = Object.entries(allTime)
    .map(([address, entry]) => ({ ...entry, address }))
    .sort((a, b) => b.score - a.score)
    .slice(0, LEADERBOARD_TOP_N)
  room.send('leaderboardAllTimeUpdate', { entries }, to ? { to } : undefined)
}
