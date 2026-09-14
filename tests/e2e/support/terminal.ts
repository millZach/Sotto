import type { Page } from '@playwright/test'

/** Exercise xterm's DOM fallback without disabling the 2D canvas used to resolve theme colors. */
export async function forceDomTerminalRenderer(page: Page): Promise<void> {
  const disableWebgl = (): void => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextId: string, options?: unknown) {
      return contextId === 'webgl2' ? null : getContext.call(this, contextId, options)
    } as typeof getContext
  }
  // Cover both the current document and any reload before the terminal mounts.
  await page.addInitScript(disableWebgl)
  await page.evaluate(disableWebgl)
}

/** Native PTY output for a fixture with exactly one running terminal, independent of its renderer. */
export async function terminalOutput(page: Page, threadId = 'workshop'): Promise<string> {
  return page.evaluate(async threadId => {
    const terminal = window.sotto!.terminal!
    const listing = await terminal.list({ threadId })
    if (!listing.ok) throw new Error(`Terminal listing failed: ${listing.error.code}`)
    const sessions = listing.value.sessions
    if (sessions.length !== 1 || sessions[0]!.status !== 'running') throw new Error('Expected exactly one running terminal')
    const session = sessions[0]!
    const snapshot = await terminal.read({ threadId, workspaceId: session.workspace.workspaceId, sessionId: session.id })
    if (!snapshot.ok) throw new Error(`Terminal read failed: ${snapshot.error.code}`)
    return snapshot.value.output
  }, threadId)
}
