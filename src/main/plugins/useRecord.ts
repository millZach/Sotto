import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { PLUGIN_USE_KEPT, pluginUseSchema, type PluginUse } from '../../shared/plugins'

const fileSchema = z.object({ version: z.literal(1), uses: z.array(z.unknown()) })

/** What a tool reports of one use. The record adds when, and an ID of its own. */
export type PluginUseReport = Omit<PluginUse, 'id' | 'at'>

/**
 * The plugin use record (ADR-0205, decision 10): what each plugin tool call did, by which thread, how it ended and
 * when. It holds no content: not what was asked for by name, not what came back. One small file in Sotto's data
 * folder, newest first, the newest PLUGIN_USE_KEPT kept. It follows Keep local history: with history off nothing is
 * written and what was kept is removed, and forgetting a thread removes that thread's entries.
 *
 * Every change runs whole, one after another: it reads what is kept, changes it and writes it before the next begins.
 * Two threads forgotten at once therefore both go, and an addition that was waiting when history was turned off finds
 * it off when its turn comes and writes nothing.
 */
export class PluginUseRecord {
  private readonly path: string
  private uses: PluginUse[] | undefined
  private queue: Promise<unknown> = Promise.resolve()
  constructor(directory: string, private readonly options: { readonly historyEnabled: () => boolean; readonly now?: () => Date }) {
    this.path = join(directory, 'plugin-use.json')
  }

  /** The kept uses, newest first, as they stand once every change asked for so far has run. */
  list(): Promise<readonly PluginUse[]> {
    return this.inTurn(async () => this.options.historyEnabled() ? [...await this.load()] : [])
  }

  /** Keeps one use. Rejects when it cannot be written; the tool that reports it does not fail for that. */
  add(report: PluginUseReport): Promise<void> {
    return this.inTurn(async () => {
      if (!this.options.historyEnabled()) return
      const uses = await this.load()
      // History may have been turned off while the file was read.
      if (!this.options.historyEnabled()) return
      const next = [{ ...report, id: randomUUID(), at: (this.options.now?.() ?? new Date()).toISOString() }, ...uses].slice(0, PLUGIN_USE_KEPT)
      await this.write(next)
    })
  }

  /** Removes forgotten threads' entries, all of them in one change. */
  forgetThreads(threadIds: readonly string[]): Promise<void> {
    const gone = new Set(threadIds)
    return this.inTurn(async () => {
      const uses = await this.load()
      const kept = uses.filter(use => !gone.has(use.threadId))
      if (kept.length !== uses.length) await this.write(kept)
    })
  }

  /** Removes everything kept: Keep local history is off. Rejects when the file could not be removed. */
  clear(): Promise<void> {
    return this.inTurn(async () => {
      this.uses = []
      await rm(this.path, { force: true })
    })
  }

  /** Runs one change after every change before it, whether those succeeded or not. */
  private inTurn<Result>(change: () => Promise<Result>): Promise<Result> {
    const run = this.queue.catch(() => undefined).then(change)
    this.queue = run
    return run
  }

  private async load(): Promise<PluginUse[]> {
    if (this.uses) return this.uses
    let uses: PluginUse[] = []
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      // An entry this version cannot read is dropped rather than failing the rest.
      if (parsed.success) uses = parsed.data.uses.flatMap(entry => { const use = pluginUseSchema.safeParse(entry); return use.success ? [use.data] : [] })
    } catch { /* No file yet, or one that cannot be read: an empty record. */ }
    this.uses = uses
    return uses
  }

  /** Writes the record whole and only then takes it as kept, so a failed write leaves what was kept as it was. */
  private async write(uses: PluginUse[]): Promise<void> {
    const next = `${this.path}.next`
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await writeFile(next, JSON.stringify({ version: 1, uses }), { mode: 0o600 })
      await rename(next, this.path)
    } catch (error) {
      await rm(next, { force: true })
      throw error
    }
    this.uses = uses
  }
}
