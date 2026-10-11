import type { TestContext, TestOptions } from 'vitest'

declare module 'vitest' {
  interface TaskMeta { fixtureSkipReason?: string | undefined }
}

/** Carry a static capability reason to the hook, preserving the case's name and skip note. */
export function withFixtureSkip(reason: string | undefined): TestOptions {
  return { meta: { fixtureSkipReason: reason } }
}

/** Call before constructing a fixture; a skipped case must acquire no fixture resources. */
export function skipUnsupportedFixture(context: TestContext): void {
  const reason = context.task.meta.fixtureSkipReason
  if (reason) context.skip(reason)
}
