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
  serverTick: Schemas.Map({ tick: Schemas.Number })
}

export const room = registerMessages(Messages)
