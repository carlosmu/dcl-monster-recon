import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // Client -> Server: reported every time a board is won.
  reportScore: Schemas.Map({ playerName: Schemas.String, points: Schemas.Number }),
  // Server -> Client: current top-of-leaderboard snapshot. weekId is the UTC date of the week's
  // Monday - it lets a client that's been connected across the Monday 00:00 UTC reset tell "I'm not
  // in the top N" (keep my score) apart from "the week rolled over" (my score is back to 0).
  leaderboardUpdate: Schemas.Map({
    weekId: Schemas.String,
    entries: Schemas.Array(Schemas.Map({ playerName: Schemas.String, score: Schemas.Number, address: Schemas.String }))
  }),
  // Client -> Server: ask for the current leaderboard snapshot (e.g. on scene load) - the
  // server's own startup broadcast only reaches whoever is already connected at that instant,
  // which is never a client that joins afterward.
  requestLeaderboard: Schemas.Map({}),
  // Server -> Client: periodic heartbeat so clients can tell the server is alive.
  serverTick: Schemas.Map({ tick: Schemas.Number }),
  // Client -> Server: ask for the caller's personal best time on a board (e.g. when it's opened).
  requestBestTime: Schemas.Map({ checkpoint: Schemas.Number, boardIndex: Schemas.Number }),
  // Client -> Server: reported every time a board is won, with the time it took to clear it.
  // Only affects best-time tracking - checkpoint/monster unlock now happens via
  // reportMonsterCaught below, since completing the last board only spawns a catchable prize in
  // the scene, it doesn't unlock the checkpoint by itself.
  reportBoardTime: Schemas.Map({
    checkpoint: Schemas.Number,
    boardIndex: Schemas.Number,
    timeSeconds: Schemas.Number
  }),
  // Client -> Server: sent only when the player physically catches the prize spawned in the scene
  // after clearing a checkpoint's last board. This is what actually unlocks the monster/checkpoint -
  // the server updates collectedMonsters/collectionCounts/highestUnlockedCheckpoint for this player.
  // If the player exhausts their catch attempts instead, this is never sent and nothing unlocks.
  reportMonsterCaught: Schemas.Map({ checkpoint: Schemas.Number }),
  // Server -> Client: the caller's personal best time for a board. bestTimeSeconds is -1 when no record exists yet.
  personalBestUpdate: Schemas.Map({ checkpoint: Schemas.Number, boardIndex: Schemas.Number, bestTimeSeconds: Schemas.Number }),
  // Client -> Server: ask for the caller's checkpoint/codex progress (e.g. on scene load).
  requestProgress: Schemas.Map({}),
  // Server -> Client: the caller's checkpoint/codex progress. collectedMonsters/collectionCounts
  // are indexed by checkpoint slot (0-based), same as the client's own arrays.
  progressUpdate: Schemas.Map({
    highestUnlockedCheckpoint: Schemas.Number,
    collectedMonsters: Schemas.Array(Schemas.Boolean),
    collectionCounts: Schemas.Array(Schemas.Number)
  }),
  // TEMP (duration calibration): Client -> Server, ask for every bestTime-* entry the caller has
  // recorded, so they can be dumped to console after a full playthrough and used to recalibrate
  // each board's `duration` in checkpoints.json. Remove once calibration is done.
  requestAllBestTimes: Schemas.Map({}),
  // TEMP (duration calibration): Server -> Client, one entry per recorded bestTime-{checkpoint}-
  // {boardIndex} key. Remove once calibration is done.
  allBestTimesUpdate: Schemas.Map({
    entries: Schemas.Array(Schemas.Map({ key: Schemas.String, seconds: Schemas.Number }))
  }),
  // Client -> Server: ask the server to consolidate every leaderboard week and every known
  // player's progress/best-times into one dated snapshot key, so it can be pulled with a single
  // `sdk-commands storage scene get`. Ignored unless the caller is OWNER_ADDRESS (see server.ts).
  requestBackup: Schemas.Map({}),
  // Server -> Client: confirms the backup snapshot was written and under which key.
  backupComplete: Schemas.Map({ snapshotKey: Schemas.String, playerCount: Schemas.Number })
}

export const room = registerMessages(Messages)
