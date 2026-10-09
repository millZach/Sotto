import type { Babysitter } from '../agents/babysitting'

/** What a Playwright journey may ask of babysitting: one pass now, rather than waiting two minutes for the next. */
export interface BabysitPassE2E {
  pass(): Promise<void>
}

declare global { var sottoBabysitE2E: BabysitPassE2E | undefined }

/**
 * Unpackaged E2E main-process harness only. Runs one babysitting pass when a journey asks, so a scripted gh can bring a
 * wake-up without the journey sleeping through the two-minute timer. Everything else is the real reader, the real
 * wake-up and the real send path. Never installed in a normal session.
 */
export function installBabysitPassE2E(babysitter: Pick<Babysitter, 'pass'>): void {
  globalThis.sottoBabysitE2E = { pass: () => babysitter.pass() }
}
