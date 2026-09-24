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

/**
 * Host keys for a spec whose pane helpers live at module level and whose `start` reads the keys once connected.
 * `key` throws until `read` has run in the current test, so a test that skips `start` fails where it first names a
 * thread, not later on a locator that matches nothing. Call `reset` before each test.
 */
export function hostKeysPerTest(): { readonly key: (id: string) => string; readonly read: (page: Page) => Promise<void>; readonly reset: () => void } {
  let keyed: ((id: string) => string) | undefined
  return {
    key: id => {
      if (keyed === undefined) throw new Error(`Host keys were not read in this test, so "${id}" cannot be keyed. Run the spec's start before naming threads.`)
      return keyed(id)
    },
    read: async page => { keyed = await hostKeys(page) },
    reset: () => { keyed = undefined },
  }
}
