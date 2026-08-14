// TEMP (crash diagnosis): the runtime tears the whole scene down and shows its generic "SCENE
// ERROR / reload or go back to discover" screen on any uncaught throw inside a system or an event
// callback - with no stack anywhere the player can see. That's unusable on mobile, where there's no
// console to read. Anything wrapped in guard() reports here instead of dying, and ui.tsx paints the
// message over the UI so it can be read straight off the phone.
//
// Remove this file (and its call sites) once the mobile crash after ~3 checkpoints is pinned down.

let capturedError: string | null = null

export function getCapturedError(): string | null {
  return capturedError
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.message}\n${e.stack ?? '(no stack)'}`
  return String(e)
}

// Runs fn, recording (rather than propagating) anything it throws. label identifies the call site.
// Only the FIRST throw is kept: once state is corrupted the following frames tend to throw their
// own cascading errors, which would otherwise bury the one that actually started it.
export function guard(label: string, fn: () => void) {
  try {
    fn()
  } catch (e) {
    const text = `[${label}] ${describe(e)}`
    console.error(text)
    if (capturedError === null) capturedError = text
  }
}
