import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // Client -> Server: reported every time a board is won.
  reportScore: Schemas.Map({ playerName: Schemas.String, points: Schemas.Number }),
  // Server -> Client: current top-of-leaderboard snapshot.
  leaderboardUpdate: Schemas.Map({
    entries: Schemas.Array(Schemas.Map({ playerName: Schemas.String, score: Schemas.Number }))
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
  // checkpointComplete is true when this was the checkpoint's last board (i.e. its monster was
  // just collected) - the server uses it to update collectedMonsters/collectionCounts/
  // highestUnlockedCheckpoint for this player.
  reportBoardTime: Schemas.Map({
    checkpoint: Schemas.Number,
    boardIndex: Schemas.Number,
    timeSeconds: Schemas.Number,
    checkpointComplete: Schemas.Boolean
  }),
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
  })
}

export const room = registerMessages(Messages)
