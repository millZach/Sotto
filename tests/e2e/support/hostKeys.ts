import type { Page } from '@playwright/test'
import { hostEntityKey } from '../../../src/shared/clientIdentity'

/**
 * Keys a thread or project ID the way the renderer does for the selected host (`host:<host id>:<id>`). In a spec
 * with no remote hosts that is the local host, which suits every spec that uses this. Pane locators, `agents.get()`
 * and commands caught at main's IPC handler all see keyed IDs. Test events, `threadDetail` and the commands a spec
 * sends itself still take the bare ID.
 */
export async function hostKeys(page: Page): Promise<(id: string) => string> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  if (hostId === undefined) throw new Error('No host is selected, so thread IDs cannot be keyed. Connect before reading host keys.')
  return id => hostEntityKey(hostId, id)
}
