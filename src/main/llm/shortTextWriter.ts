import type { AppSettings } from '../../shared/settings'
import type { ShortTextPrompt } from '../agents/host'

export interface ShortTextRequest {
  /** What this text is for, for the failure log only; never sent to the model. */
  readonly purpose: string
  /** The whole instruction the model follows. */
  readonly instruction: string
  /** The only material sent with the instruction. Callers choose what belongs here. */
  readonly material: string
  /** Longer output is cut back to this at a word boundary. */
  readonly maxCharacters: number
  /**
   * 'line' (the default) keeps the first non-empty line, which is what a name
   * or a subject is. 'text' keeps every line, for the callers that ask for
   * a written body; the cut and the emptiness rule are the same either way.
   */
  readonly shape?: 'line' | 'text'
}

export interface ShortTextFailure {
  readonly at: number
  readonly purpose: string
  /** 'unavailable' (the thread's provider writes nothing), 'failed' or 'empty'. */
  readonly reason: string
}

/**
 * The side call itself: a thread's own provider client asked on its own account and model (ADR-0026).
 * Null means that provider writes nothing for this thread; a throw means it was asked and failed.
 */
export type ProviderSideWriter = (threadId: string, prompt: ShortTextPrompt, signal?: AbortSignal) => Promise<string | null>

export interface ShortTextWriterDependencies {
  readonly write: ProviderSideWriter
  readonly now?: () => number
  /** Local observability for a silent failure; must never throw into the caller. */
  readonly onFailure?: (failure: ShortTextFailure) => void
}

/**
 * Short text for the jobs where Sotto writes on the user's behalf - thread
 * titles, branch names, commit messages and pull request text - written by the
 * thread's own provider on the side (ADR-0026). The first exchange, the first
 * prompt or the diff stays with the provider it was already written for; no
 * other service and no key is involved. Every failure resolves to `null`: a
 * caller keeps whatever it already had, and the user is never shown an error
 * for text they did not ask for.
 */
export class ShortTextWriter {
  private readonly now: () => number
  private readonly shutdown = new AbortController()
  private readonly operations = new Set<Promise<string | null>>()

  constructor(private readonly dependencies: ShortTextWriterDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  /**
   * A host shutdown cancels writing: every side call in flight is told to stop its client, and this waits
   * until they have, so no client outlives the host that started it.
   */
  async close(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled([...this.operations])
  }

  write(threadId: string, request: ShortTextRequest): Promise<string | null> {
    if (this.shutdown.signal.aborted) return Promise.resolve(null)
    const pending = this.performWrite(threadId, request)
    this.operations.add(pending)
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }

  private async performWrite(threadId: string, request: ShortTextRequest): Promise<string | null> {
    let content: string | null
    try { content = await this.dependencies.write(threadId, { instruction: request.instruction, material: request.material }, this.shutdown.signal) }
    catch { return this.shutdown.signal.aborted ? null : this.fail(request.purpose, 'failed') }
    if (this.shutdown.signal.aborted) return null
    if (content === null) return this.fail(request.purpose, 'unavailable')
    const text = request.shape === 'text' ? trimToText(content, request.maxCharacters) : trimToLine(content, request.maxCharacters)
    return text ?? this.fail(request.purpose, 'empty')
  }

  private fail(purpose: string, reason: string): null {
    try { this.dependencies.onFailure?.({ at: this.now(), purpose, reason }) }
    catch { /* Observability must never affect the caller. */ }
    return null
  }
}

export interface GatedWriterShape<Input, Output> {
  /** The setting that turns this job off. */
  readonly enabled: (settings: AppSettings) => boolean
  /** Input with nothing to describe is not sent; absent, every input is. */
  readonly worthAsking?: (input: Input) => boolean
  /** The request, which may read the settings of the moment (the writing style of commit and pull request text). */
  readonly request: (input: Input, settings: AppSettings) => ShortTextRequest
  /** Turns the written text into what the caller keeps; absent, the text itself. */
  readonly shape?: (written: string | null) => Output
}

/**
 * The writer every job is built from, asked about one thread at a time. The off
 * switch is read for every request, so turning generation off stops the next
 * one without a restart, and no provider is asked anything while it is off or
 * while settings cannot be read.
 */
export function settingsGatedWriter<Input, Output = string | null>(
  writer: Pick<ShortTextWriter, 'write'>,
  getSettings: () => AppSettings | Promise<AppSettings>,
  job: GatedWriterShape<Input, Output>,
): (threadId: string, input: Input) => Promise<Output | null> {
  return async (threadId, input) => {
    let settings: AppSettings
    try { settings = await getSettings() }
    catch { return null }
    if (!job.enabled(settings) || job.worthAsking?.(input) === false) return null
    const written = await writer.write(threadId, job.request(input, settings))
    return job.shape ? job.shape(written) : (written as Output)
  }
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
  return cutAtBoundary(text, maxCharacters, ' ')
}

/** Cuts text past the ceiling at the last boundary character, unless that would lose more than half of it. */
function cutAtBoundary(text: string, maxCharacters: number, ...boundaries: string[]): string | null {
  if (text.length === 0) return null
  if (text.length <= maxCharacters) return text
  const cut = text.slice(0, maxCharacters)
  const boundary = Math.max(...boundaries.map(mark => cut.lastIndexOf(mark)))
  return (boundary > maxCharacters / 2 ? cut.slice(0, boundary) : cut).trim()
}

/**
 * The same promise for text that is meant to have lines: a model asked for a
 * written body sometimes wraps the whole answer in a code fence, and blank
 * lines multiply. The fence is dropped, runs of blank lines collapse to one,
 * and an over-long body is cut at a line or a word rather than mid-word.
 */
export function trimToText(content: string | null, maxCharacters: number): string | null {
  if (content === null) return null
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(content.trim())
  const text = (fenced?.[1] ?? content)
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return cutAtBoundary(text, maxCharacters, '\n', ' ')
}
