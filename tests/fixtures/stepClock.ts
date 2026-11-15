import { vi } from 'vitest'

/** Vitest's fake clock, moved a step at a time, with the real work the test waits for settled after every step. */
export interface StepClock {
  /** Waits for the real work in flight to finish. */
  settle(): Promise<void>
  /** Moves the fake clock `ms`, one step by default, then settles. */
  step(ms?: number): Promise<void>
  /** Steps through `ms` of fake time. */
  pass(ms: number): Promise<void>
  /** Steps until `work` is done, giving it at most two minutes of fake time. */
  until<T>(work: Promise<T>): Promise<T>
}

/** Fake milliseconds in a step: a tenth of a streamed chunk's fifty. */
export const STEP_MS = 5
const turn = globalThis.setImmediate

/** File work in flight: a file system request, an open file handle or a close. */
export const fileWork = (resource: string): boolean => /^(FSReq|FileHandle|CloseReq)/u.test(resource)

/**
 * Waits until none of the process's active resources is one `inFlight` names, three turns in a row: by default file work,
 * so a step never ends with a write half done. It waits for the work, not for time.
 */
export async function filesSettled(inFlight: (resource: string) => boolean = fileWork): Promise<void> {
  for (let quiet = 0; quiet < 3;) {
    await new Promise<void>(resolve => { turn(resolve) })
    quiet = process.getActiveResourcesInfo().some(inFlight) ? 0 : quiet + 1
  }
}

/**
 * The fake clock stepped `STEP_MS` at a time, with `settle` after every step, as the owner-scale benchmarks step it. The test
 * fakes the timers itself (`vi.useFakeTimers`); every count it takes on this clock is the same on any machine, since no step
 * starts before the real work of the last one is done.
 */
export function stepClock(settle: () => Promise<void> = filesSettled): StepClock {
  const step = async (ms = STEP_MS): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await settle() }
  const pass = async (ms: number): Promise<void> => { for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) await step() }
  const until = async <T>(work: Promise<T>): Promise<T> => {
    let done = false
    void work.then(() => { done = true }, () => { done = true })
    await settle()
    for (let elapsed = 0; !done; elapsed += STEP_MS) { if (elapsed > 120_000) throw new Error('not done'); await step() }
    return work
  }
  return { settle, step, pass, until }
}
