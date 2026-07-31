import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // Client -> Server: reported every time a board is won.
  reportScore: Schemas.Map({ playerName: Schemas.String, points: Schemas.Number }),
  // Server -> Client: current top-of-leaderboard snapshot.
  leaderboardUpdate: Schemas.Map({
    entries: Schemas.Array(Schemas.Map({ playerName: Schemas.String, score: Schemas.Number }))
  }),
  // Server -> Client: periodic heartbeat so clients can tell the server is alive.
  serverTick: Schemas.Map({ tick: Schemas.Number }),
  // Client -> Server: ask for the caller's personal best time on a board (e.g. when it's opened).
  requestBestTime: Schemas.Map({ checkpoint: Schemas.Number, boardIndex: Schemas.Number }),
  // Client -> Server: reported every time a board is won, with the time it took to clear it.
  reportBoardTime: Schemas.Map({ checkpoint: Schemas.Number, boardIndex: Schemas.Number, timeSeconds: Schemas.Number }),
  // Server -> Client: the caller's personal best time for a board. bestTimeSeconds is -1 when no record exists yet.
  personalBestUpdate: Schemas.Map({ checkpoint: Schemas.Number, boardIndex: Schemas.Number, bestTimeSeconds: Schemas.Number })
}

export const room = registerMessages(Messages)
