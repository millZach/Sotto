import { expect, it, vi } from 'vitest'

/** Vitest's own deadline for `vi.waitFor` and `vi.waitUntil`, and a moment past it that the suite's five seconds still cover. */
const VITEST_WAIT_MS = 1_000
const PAST_VITEST_WAIT_MS = VITEST_WAIT_MS + 300

/**
 * `tests/setup.ts` gives `vi.waitFor` and `vi.waitUntil` five seconds when a call names no deadline. Each wait below turns
 * true just after vitest's own one second, so it fails without that setup and passes with it, in whichever environment
 * the file runs. A deadline or interval a call passes is its own.
 */
export function suiteWaitDeadlineCases(environment: 'node' | 'jsdom'): void {
  it(`waits past vitest's one second when a call names no deadline (${environment})`, async () => {
    expect(typeof document === 'undefined' ? 'node' : 'jsdom').toBe(environment)
    const ready = Date.now() + PAST_VITEST_WAIT_MS
    let checks = 0
    await Promise.all([
      vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(ready)),
      vi.waitUntil(() => Date.now() >= ready),
      // An interval alone keeps that interval and still gets the suite's deadline: about four checks rather than twenty-six.
      vi.waitUntil(() => { checks++; return Date.now() >= ready }, { interval: 400 }),
    ])
    expect(checks).toBeLessThan(10)
  })

  it(`keeps a deadline the call names (${environment})`, async () => {
    const ready = Date.now() + 2_000
    await expect(vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(ready), { timeout: 200 })).rejects.toThrow()
    await expect(vi.waitUntil(() => Date.now() >= ready, 200)).rejects.toThrow('Timed out in waitUntil!')
  })
}
