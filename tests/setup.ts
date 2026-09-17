import { promises as fsPromises } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

// jsdom keeps one web storage per test file, so whatever a test leaves behind is read by the next one.
// The renderer paints the cached agent shell on its first frame, so a leftover shell makes the first
// assertion after mounting a race between that stale paint and the bridge's first answer — a race a
// loaded machine loses. Every test starts from empty storage instead.
afterEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear()
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear()
})

// Windows keeps a directory entry alive for a moment after the last handle on it closes, so deleting a
// fixture's temporary folder right after the child process that used it exited fails with ENOTEMPTY or
// EBUSY — on a loaded machine often enough to redden CI, from a `finally` that is only tidying up.
// Node already retries such a delete when asked; every recursive delete in a test run asks by default.
// A caller that passes its own `maxRetries` still wins.
const removeTree = fsPromises.rm
fsPromises.rm = function rmWithWindowsRetries(path, options) {
  return options?.recursive === true
    ? removeTree(path, { maxRetries: 10, retryDelay: 50, ...options })
    : removeTree(path, options)
} as typeof fsPromises.rm
// `import { rm } from 'node:fs/promises'` binds the builtin's exports as they were; this republishes them.
syncBuiltinESMExports()
