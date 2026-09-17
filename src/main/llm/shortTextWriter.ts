import type { AppSettings } from '../../shared/settings'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Short writing never blocks anything a person is waiting on, so the deadline is
 * generous compared with dictation cleanup: a title that arrives late still
 * arrives, and a request that hangs is abandoned rather than retried.
 */
const WRITE_TIMEOUT_MS = 20_000

export interface ShortTextRequest {
  /** What this text is for, for the failure log only; never sent to the model. */
  readonly purpose: string
  /** The whole instruction the model follows. */
  readonly instruction: string
  /** The only material sent with the instruction. Callers choose what belongs here. */
  readonly material: string
  /** Longer output is cut back to this at a word boundary. */
  readonly maxCharacters: number
  readonly maxTokens?: number
  /**
   * A commit message has a subject and sometimes a body, so its answer is kept
   * whole instead of cut to its first line. Everything else is one line.
   */
  readonly multiline?: boolean
}

export interface ShortTextFailure {
  readonly at: number
  readonly purpose: string
  /** 'off', 'no-key', 'http-<status>', 'empty', 'timeout', 'network', 'settings'. */
  readonly reason: string
}

export interface ShortTextWriterDependencies {
  readonly getSettings: () => AppSettings | Promise<AppSettings>
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  /** Local observability for a silent failure; must never throw into the caller. */
  readonly onFailure?: (failure: ShortTextFailure) => void
}

/**
 * One line of text written by a small OpenRouter model, for the jobs where Sotto
 * writes on the user's behalf: a thread's title today, commit messages and pull
 * request text next. Every failure resolves to `null` - a caller keeps whatever
 * it already had, and the user is never shown an error for text they did not ask
 * for. The OpenRouter key is read through the same settings path the transcript
 * cleanup uses and never leaves this module.
 */
export class ShortTextWriter {
  private readonly fetchFn: typeof fetch
  private readonly now: () => number

  constructor(private readonly dependencies: ShortTextWriterDependencies) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.now = dependencies.now ?? Date.now
  }

  async write(request: ShortTextRequest): Promise<string | null> {
    let settings: AppSettings
    try { settings = await this.dependencies.getSettings() }
    catch { return this.fail(request.purpose, 'settings') }
    if (settings.llmApiKey.length === 0) return this.fail(request.purpose, 'no-key')

    try {
      const response = await this.fetchFn(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.llmApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: settings.writingModel,
          messages: [
            { role: 'system', content: request.instruction },
            { role: 'user', content: request.material },
          ],
          max_tokens: request.maxTokens ?? 200,
          reasoning: { enabled: false },
        }),
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      })
      if (!response.ok) return this.fail(request.purpose, `http-${response.status}`)
      const content = extractContent(await response.json())
      const text = request.multiline ? trimToBlock(content, request.maxCharacters) : trimToLine(content, request.maxCharacters)
      return text ?? this.fail(request.purpose, 'empty')
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      return this.fail(request.purpose, timedOut ? 'timeout' : 'network')
    }
  }

  private fail(purpose: string, reason: string): null {
    try { this.dependencies.onFailure?.({ at: this.now(), purpose, reason }) }
    catch { /* Observability must never affect the caller. */ }
    return null
  }
}

function extractContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content
  return typeof content === 'string' ? content : null
}

/**
 * A model that was asked for one line sometimes answers with a preamble, quotes
 * or a trailing period. The first non-empty line, unquoted and unpunctuated, is
 * the text; anything longer than the caller's ceiling is cut at a word boundary.
 */
export function trimToLine(content: string | null, maxCharacters: number): string | null {
  if (content === null) return null
  const line = content.split('\n').map(part => part.trim()).find(part => part.length > 0)
  if (line === undefined) return null
  const text = line
    .replace(/\s+/gu, ' ')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, '')
    .replace(/[.、。]+$/u, '')
    .trim()
  if (text.length === 0) return null
  if (text.length <= maxCharacters) return text
  const cut = text.slice(0, maxCharacters)
  const boundary = cut.lastIndexOf(' ')
  return (boundary > maxCharacters / 2 ? cut.slice(0, boundary) : cut).trim()
}

/**
 * The same tidy-up for text that is allowed more than one line: a fenced block
 * the model wrapped its answer in is removed, trailing spaces and runs of blank
 * lines go, and anything past the ceiling is cut at a line boundary so a body is
 * never left half-written.
 */
export function trimToBlock(content: string | null, maxCharacters: number): string | null {
  if (content === null) return null
  const lines = content.replace(/\r\n/gu, '\n').split('\n').map(line => line.trimEnd())
  if (lines[0]?.startsWith('```')) {
    lines.shift()
    const end = lines.findIndex(line => line.startsWith('```'))
    if (end >= 0) lines.length = end
  }
  const text = lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
  if (text.length === 0) return null
  if (text.length <= maxCharacters) return text
  const cut = text.slice(0, maxCharacters)
  const boundary = cut.lastIndexOf('\n')
  return (boundary > maxCharacters / 2 ? cut.slice(0, boundary) : cut).trim()
}
