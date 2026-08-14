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

// Debug layout border colors at 100% opacity, so they're clearly visible outlining containers.
export const DEBUG_BORDER_RED = Color4.create(1, 0, 0, 1)
export const DEBUG_BORDER_GREEN = Color4.create(0, 1, 0, 1)
export const DEBUG_BORDER_BLUE = Color4.create(0, 0, 1, 1)
export const DEBUG_BORDER_WHITE = Color4.create(1, 1, 1, 1)
