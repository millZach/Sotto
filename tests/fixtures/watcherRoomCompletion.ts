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
