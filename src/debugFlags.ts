// Every debug toggle in the scene, in one place, so the full debug surface can be read (and reset
// before a deploy) without grepping through ui.tsx. These are compile-time constants, not runtime
// settings - flip one here and re-deploy.

import { Color4 } from '@dcl/sdk/math'

// Overlays each board cell with its grid coordinate (A1, B3, ...), to reference specific cells when
// reporting a layout or match bug.
export const DEBUG_CELL_LABELS = false

// Outlines every UI container with a 2px border in the DEBUG_BORDER_* colors below, to see how the
// nested boxes actually resolve.
export const DEBUG_LAYOUT_BORDERS = false

// Pins a readout of UiCanvasInformation (real screen size, device pixel ratio) to the bottom-left,
// for checking how the 1920x1080 virtual canvas maps onto a real screen.
export const DEBUG_CANVAS_INFO = true

// TEMP (duration calibration): dumps every recorded board best-time to console on scene load, to
// recalibrate checkpoints.json's per-board `duration` from a real playthrough. Set to false (or
// remove, along with requestAllBestTimes/allBestTimesUpdate in messages.ts/server.ts) once done.
export const DEBUG_DUMP_BEST_TIMES = true

// Manual backup trigger: fires requestBackup once on scene load, which asks the server to
// consolidate all leaderboard/progress/best-time data into one dated snapshot key (server ignores
// the request unless the caller is OWNER_ADDRESS in server.ts). Flip to true, load the scene as the
// owner wallet, check the console for the resulting key, then flip back to false.
export const DEBUG_TRIGGER_BACKUP = false

// Visual-only: shows every monster in the Codex as if collected, to check the prize sprite sheet.
// Does not touch real collection progress. Flip to false to see actual player progress.
export const DEBUG_CODEX_SHOW_ALL_MONSTERS = false

// Visual-only: forces the header score display to a 5-digit value, to check it fits without
// overflowing the box. Does not touch the real score. Flip to false to see the actual score.
export const DEBUG_SCORE_OVERRIDE = false

// Unlocks every checkpoint so any one can be launched from the checkpoint select, for testing a
// specific board without playing up to it. Local only: it overrides the server's progressUpdate on
// the way in, but nothing writes it back, so real stored progress is left untouched.
export const DEBUG_UNLOCK_ALL_CHECKPOINTS = false

// Visual-only: replaces the leaderboard with the 10 made-up players below, so the leaderboard
// screen and the in-world 3D panel can both be checked full without 10 real wallets having played.
// Nothing is sent to the server and no real score is touched - the fake addresses belong to nobody,
// so adoptLeaderboardScore never matches one and the header score is left alone.
export const DEBUG_FAKE_LEADERBOARD = false

// Deliberately awkward on purpose: a name long enough to run into the score column, a single-letter
// name, and a 5-digit score, so the layout is checked at its extremes rather than at a comfortable
// average. The addresses are placeholders - no profile exists for them, so every row falls back to
// fallback_profile_pic.png. Swap one for your own wallet to see a real face in the mix.
export const DEBUG_FAKE_LEADERBOARD_ENTRIES: Array<{ playerName: string; score: number; address: string }> = [
  { playerName: 'MonsterHunter99', score: 12480, address: '0x1000000000000000000000000000000000000001' },
  { playerName: 'Luz', score: 9975, address: '0x1000000000000000000000000000000000000002' },
  { playerName: 'thegreatpumpkinsmasher', score: 8210, address: '0x1000000000000000000000000000000000000003' },
  { playerName: 'Nyx', score: 7640, address: '0x1000000000000000000000000000000000000004' },
  { playerName: 'Vittorio', score: 6155, address: '0x1000000000000000000000000000000000000005' },
  { playerName: 'dcl_wanderer', score: 5030, address: '0x1000000000000000000000000000000000000006' },
  { playerName: 'Ramona', score: 4415, address: '0x1000000000000000000000000000000000000007' },
  { playerName: 'K', score: 3200, address: '0x1000000000000000000000000000000000000008' },
  { playerName: 'PixelPirate', score: 1875, address: '0x1000000000000000000000000000000000000009' },
  { playerName: 'zzz_lastplace_zzz', score: 640, address: '0x100000000000000000000000000000000000000a' }
]

// Debug layout border colors at 100% opacity, so they're clearly visible outlining containers.
export const DEBUG_BORDER_RED = Color4.create(1, 0, 0, 1)
export const DEBUG_BORDER_GREEN = Color4.create(0, 1, 0, 1)
export const DEBUG_BORDER_BLUE = Color4.create(0, 0, 1, 1)
export const DEBUG_BORDER_WHITE = Color4.create(1, 1, 1, 1)
