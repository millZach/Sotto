// Windows terminates a child on SIGTERM without running the fake Linux host's signal handler.
// The caller still makes every native signal/liveness decision; this only retires its fixture lease.
import fs from 'node:fs'
import path from 'node:path'

export const FAKE_HOST_MARKER = 'sotto-fake-ssh-host'

export function fakeHostKill(dataDirectory, nativeKill, platform = process.platform) {
  if (platform !== 'win32') return nativeKill
  const lockPath = path.join(dataDirectory, 'host-listener.lock')
  const descriptorPath = path.join(dataDirectory, 'host-listener.json')
  const pending = new Map()
  const owner = pid => {
    try {
      const text = fs.readFileSync(lockPath, 'utf8'), lease = JSON.parse(text)
      const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
      if (lease.fixture !== FAKE_HOST_MARKER || descriptor.fixture !== FAKE_HOST_MARKER || lease.pid !== pid || descriptor.pid !== pid ||
        typeof lease.nonce !== 'string' || !lease.nonce || typeof lease.instance !== 'string' || !lease.instance || descriptor.instance !== lease.instance) return undefined
      return { text, instance: lease.instance }
    } catch { return undefined } // Missing, unreadable or malformed identity cannot authorize fixture cleanup.
  }
  return function kill(pid, signal) {
    const captured = signal === 'SIGTERM' ? owner(pid) : undefined
    try {
      const result = nativeKill(pid, signal)
      if (captured) pending.set(pid, captured)
      return result
    } catch (error) {
      if (signal === 0 && error.code === 'ESRCH') {
        const stopped = pending.get(pid)
        pending.delete(pid)
        if (stopped) {
          const current = owner(pid)
          if (current?.text === stopped.text && current.instance === stopped.instance) {
            try { fs.rmSync(lockPath) } catch { /* Cleanup failure does not replace the caller's native signal error. */ }
          }
        }
      }
      throw error
    }
  }
}

export function installFakeHostSignalCleanup(dataDirectory) {
  if (process.platform === 'win32') process.kill = fakeHostKill(dataDirectory, process.kill.bind(process))
}
