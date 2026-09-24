import type { Page } from '@playwright/test'
import { hostEntityKey } from '../../../src/shared/clientIdentity'

/**
 * Keys a thread or project ID the way the renderer does, by the host that owns it (`host:<host id>:<id>`).
 * Pane locators, `agents.get()` and commands caught at main's IPC handler all see keyed IDs. Test events,
 * `threadDetail` and the commands a spec sends itself still take the bare ID.
 */
export async function hostKeys(page: Page): Promise<(id: string) => string> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  return id => hostEntityKey(hostId, id)
}
