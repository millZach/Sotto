import { test, type Page } from '@playwright/test'

/**
 * PowerShell's prompt, `PS <folder>> `. ConPTY may wrap the folder, and it often draws the trailing space as a cursor
 * move rather than a space until something is typed after it, so only the `>` is required.
 */
export const POWERSHELL_PROMPT = /PS [\s\S]*>/u

/**
 * How long a fresh shell may take to print its first prompt. A cold `pwsh` start on a loaded runner has taken longer
 * than Playwright's default five seconds (#1051). The wait ends as soon as the prompt appears, so a deadline that is
 * never reached costs nothing.
 */
export const SHELL_START_TIMEOUT = 60_000

/** What a prompt wait reads: the terminal's whole output and its status, as the terminal bridges report them. */
export interface ShellReading { output: string; status: string }

/** Statuses after which the shell will never print a prompt. */
const ENDED = new Set(['exited', 'interrupted', 'unavailable'])
/** Terminal escape sequences, which are not the shell's output. */
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/gu

/**
 * Wait until a fresh shell has printed its first prompt, before anything is typed or written into it.
 *
 * A running PTY and a mounted xterm do not mean the shell reads commands. Keys typed while PowerShell is still starting
 * wait in the console and run late, so a journey's next five-second check ran out before the command did (#1051).
 * `read` returns the terminal, or undefined before it is listed; a failed read counts as not yet. `after` names text the
 * shell prints before the prompt that counts, such as a provider's exit line; only a prompt after its last occurrence
 * matches. On other platforms the shell's prompt is the user's own, so any text the shell printed stands for it.
 *
 * Each wait adds its own deadline to the test's timeout, so prompt waits never spend the time the rest of the journey
 * was given, and a slow start fails with this wait's message rather than Playwright's generic test timeout. A shell
 * that ends after the wait saw it start fails at once. An ended status seen first is waited out, since a reopened
 * terminal reports its old state until it starts again.
 */
export async function waitForShellPrompt(read: () => Promise<ShellReading | undefined>, options: { after?: string } = {}): Promise<void> {
  const info = test.info()
  if (info.timeout > 0) info.setTimeout(info.timeout + SHELL_START_TIMEOUT)
  const deadline = Date.now() + SHELL_START_TIMEOUT
  let started = false, last: ShellReading | undefined, failure: unknown
  for (;;) {
    try { last = await read(); failure = undefined } catch (error) { failure = error }
    if (last) {
      const ended = ENDED.has(last.status)
      if (ended && started) throw new Error(`The shell ended (${last.status}) before it printed its first prompt. Output: ${JSON.stringify(last.output.slice(-400))}`)
      if (!ended) started = true
      if (started && shellPrinted(last.output, options.after)) return
    }
    if (Date.now() >= deadline) {
      const seen = last ? `Its terminal is ${last.status}. Output: ${JSON.stringify(last.output.slice(-400))}` : `Its terminal was never listed${failure ? ` (${String(failure)})` : ''}.`
      throw new Error(`The shell printed no prompt within ${SHELL_START_TIMEOUT / 1000} s. ${seen}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

function shellPrinted(output: string, after: string | undefined): boolean {
  let text = output
  if (after !== undefined) {
    const at = text.lastIndexOf(after)
    if (at < 0) return false
    text = text.slice(at + after.length)
  }
  if (process.platform === 'win32') return POWERSHELL_PROMPT.test(text)
  return /\S/u.test(text.replace(ESCAPES, ''))
}

/** A thread's one terminal in Tools or its drawer, in whatever state it is, or undefined while there is not exactly one. */
export async function threadTerminal(page: Page, threadId = 'workshop', place: 'tools' | 'drawer' = 'tools'): Promise<ShellReading | undefined> {
  return page.evaluate(async ({ threadId, place }) => {
    const terminal = window.sotto!.terminal!
    const listing = await terminal.list({ threadId, place })
    if (!listing.ok || listing.value.sessions.length !== 1) return undefined
    const snapshot = await terminal.read({ threadId, workspaceId: listing.value.workspace.workspaceId, sessionId: listing.value.sessions[0]!.id })
    return snapshot.ok ? { output: snapshot.value.output, status: snapshot.value.session.status } : undefined
  }, { threadId, place })
}

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
