import { startupMarks, type StartupMark } from '../performance/startupMarks'
import type { E2EConfiguration } from './e2eBoundary'

/** What `tests/e2e/launch-time.spec.ts` may ask of main's startup marks: the ones launch has reached. */
export interface StartupMarksE2E {
  read(): readonly StartupMark[]
}

declare global { var sottoStartupMarksE2E: StartupMarksE2E | undefined }

/**
 * Unpackaged e2e launches only. Lets a Playwright spec read the startup marks with `app.evaluate`; a normal session,
 * whose configuration is null, has no way to read them, and nothing writes them anywhere.
 */
export function exposeStartupMarksForE2E(configuration: E2EConfiguration | null): void {
  if (configuration === null) return
  globalThis.sottoStartupMarksE2E = { read: startupMarks }
}
