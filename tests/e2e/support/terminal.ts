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
export async function terminalOutput(page: Page, threadId = 'workshop', place: 'tools' | 'drawer' = 'tools'): Promise<string> {
  return page.evaluate(async ({ threadId, place }) => {
    const terminal = window.sotto!.terminal!
    const listing = await terminal.list({ threadId, place })
    if (!listing.ok) throw new Error(`Terminal listing failed: ${listing.error.code}`)
    const sessions = listing.value.sessions
    if (sessions.length !== 1 || sessions[0]!.status !== 'running') throw new Error('Expected exactly one running terminal')
    const session = sessions[0]!
    const snapshot = await terminal.read({ threadId, workspaceId: session.workspace.workspaceId, sessionId: session.id })
    if (!snapshot.ok) throw new Error(`Terminal read failed: ${snapshot.error.code}`)
    return snapshot.value.output
  }, { threadId, place })
}

export function painted(page: Page, css: string): Promise<string> {
  return page.evaluate(css => {
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.background = css
    const context = document.createElement('canvas').getContext('2d')!
    context.fillStyle = getComputedStyle(probe).backgroundColor
    probe.remove()
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map(channel => channel!.toString(16).padStart(2, '0')).join('')}`
  }, css)
}

export function near(actual: string | undefined, expected: string, tolerance = 3): boolean {
  if (!actual) return false
  const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
  const a = channels(actual), b = channels(expected)
  return a.every((value, index) => Math.abs(value - b[index]!) <= tolerance)
}
