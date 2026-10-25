/** Fixture-only completion of the actual page callback, without acknowledging every room send. */
export function createRoomCompletion<State>(readCpu: () => number) {
  let revision = 0
  let room: State | undefined
  const waiting = new Set<() => void>()
  return {
    receive(state: State, sourceRevision: number): void {
      room = state; revision = sourceRevision
      for (const check of waiting) check()
    },
    wait(target: number, timeoutMs = 10_000): Promise<{ revision: number; room: State; cpuMs: number }> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(check)
          reject(new Error(`Room completion timed out: target=${target}, page=${revision}`))
        }, timeoutMs)
        const check = () => {
          if (room === undefined || revision < target) return
          clearTimeout(timer); waiting.delete(check)
          try { resolve({ revision, room, cpuMs: readCpu() }) }
          catch (error) { reject(error) }
        }
        waiting.add(check); check()
      })
    },
  }
}

/**
 * Whether two rooms show the same: equal apart from when each was read and which build it was. A build that changed
 * nothing else sends nothing (#1450), so the page may hold the build before the latest one main made.
 */
export function sameShownRoom(held: { readonly observedAt: string; readonly sequence?: number | undefined }, latest: { readonly observedAt: string; readonly sequence?: number | undefined }): boolean {
  const shown = (room: object) => JSON.stringify({ ...room, observedAt: undefined, sequence: undefined })
  return shown(held) === shown(latest)
}
