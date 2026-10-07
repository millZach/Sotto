import { randomBytes } from 'node:crypto'
import { parseHostEntityKey } from '../../shared/clientIdentity'
import type { AgentVisual } from '../../shared/visuals'
import { VISUAL_SCHEME, type VisualPageRequest, type VisualPageResult } from '../../shared/visualPages'
import type { VisualTheme } from '../../shared/visualGuest'
import { visualPageNotFound, visualPageResponse } from './visualPagePolicy'

/**
 * Who gets an interactive visual's page, and when (ADR-0060). Main keeps the page in its own visual store; the window
 * asks for a visual by thread and ID and is given a one-time address on the `sotto-visual:` scheme, which a guest
 * loads once.
 */

/** How long an address waits to be loaded before it lapses, and how many may wait at once. */
export const VISUAL_PAGE_TOKEN_TTL_MS = 30_000
export const VISUAL_PAGE_TOKENS_MAX = 16
const PAGE_ADDRESS = new RegExp(`^${VISUAL_SCHEME}://page/([A-Za-z0-9_-]{43})$`, 'u')

export interface VisualPageStoreDependencies {
  /** The visual this computer's thread holds under this ID, from main's own store; undefined when it holds none. */
  read(threadId: string, visualId: string): AgentVisual | undefined
  /** The Figtree faces, as `@font-face` rules with data URLs. */
  readonly fontCss: string
  readonly now?: () => number
}

interface WaitingPage { readonly threadId: string; readonly visualId: string; readonly theme: VisualTheme; readonly expires: number }

/**
 * The thread on this computer a window's thread key names: the key itself, or its ID when the key names this host.
 * A key for another host names a paired host's thread, whose visuals are not here: undefined, and nothing is read.
 */
export function localVisualThreadId(threadKey: string, localHostId: string | undefined): string | undefined {
  const key = parseHostEntityKey(threadKey)
  if (key === null) return threadKey
  return localHostId !== undefined && key.hostId === localHostId ? key.id : undefined
}

/** One-time addresses for the window, and the one load each allows. */
export class VisualPageStore {
  private readonly waiting = new Map<string, WaitingPage>()
  constructor(private readonly dependencies: VisualPageStoreDependencies) {}
  private now(): number { return this.dependencies.now?.() ?? Date.now() }

  /** The interactive visual this thread holds under this ID, or undefined, however the store answers. */
  private readPage(threadId: string, visualId: string): AgentVisual | undefined {
    let visual: AgentVisual | undefined
    try { visual = this.dependencies.read(threadId, visualId) } catch { return undefined }
    return visual?.kind === 'interactive' ? visual : undefined
  }

  /**
   * A one-time address for a visual this thread holds and that is an interactive page; why not, otherwise. Turning off
   * Let agents draw visuals in threads stops new visuals, not these: a page already in a thread still shows, as a
   * diagram does (ADR-0056).
   */
  open(request: VisualPageRequest): VisualPageResult {
    if (!this.readPage(request.threadId, request.visualId)) return { ok: false, reason: 'Sotto no longer has this page, so it is not shown.' }
    this.sweep()
    while (this.waiting.size >= VISUAL_PAGE_TOKENS_MAX) this.waiting.delete(this.waiting.keys().next().value!)
    const token = randomBytes(32).toString('base64url')
    this.waiting.set(token, { threadId: request.threadId, visualId: request.visualId, theme: request.theme, expires: this.now() + VISUAL_PAGE_TOKEN_TTL_MS })
    return { ok: true, url: `${VISUAL_SCHEME}://page/${token}` }
  }

  /** Whether this exact address is waiting for its one load. A guest is attached for nothing else. */
  isAwaitingLoad(url: string): boolean {
    const token = PAGE_ADDRESS.exec(url)?.[1]
    const entry = token === undefined ? undefined : this.waiting.get(token)
    return entry !== undefined && entry.expires > this.now()
  }

  /** The page for a waiting address, once; the address is spent whether or not the page can still be read. */
  serve(url: string): Response {
    const token = PAGE_ADDRESS.exec(url)?.[1]
    const entry = token === undefined ? undefined : this.waiting.get(token)
    if (token !== undefined) this.waiting.delete(token)
    if (!entry || entry.expires <= this.now()) return visualPageNotFound()
    const visual = this.readPage(entry.threadId, entry.visualId)
    return visual ? visualPageResponse(visual.source, entry.theme, this.dependencies.fontCss) : visualPageNotFound()
  }

  private sweep(): void {
    const now = this.now()
    for (const [token, entry] of this.waiting) if (entry.expires <= now) this.waiting.delete(token)
  }
}
