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
 */
export class PluginUseRecord {
  private readonly path: string
  private uses: PluginUse[] | undefined
  private writing: Promise<void> = Promise.resolve()
  constructor(directory: string, private readonly options: { readonly historyEnabled: () => boolean; readonly now?: () => Date }) {
    this.path = join(directory, 'plugin-use.json')
  }

  /** The kept uses, newest first. */
  async list(): Promise<readonly PluginUse[]> {
    if (!this.options.historyEnabled()) return []
    return [...await this.load()]
  }

  /** Keeps one use. A record that cannot be written never fails the tool call it describes. */
  async add(report: PluginUseReport): Promise<void> {
    if (!this.options.historyEnabled()) return
    const uses = await this.load()
    uses.unshift({ ...report, id: randomUUID(), at: (this.options.now?.() ?? new Date()).toISOString() })
    uses.length = Math.min(uses.length, PLUGIN_USE_KEPT)
    await this.save()
  }

  /** Removes a forgotten thread's entries. */
  async forgetThread(threadId: string): Promise<void> {
    const uses = await this.load()
    const kept = uses.filter(use => use.threadId !== threadId)
    if (kept.length === uses.length) return
    this.uses = kept
    await this.save()
  }

  /** Removes everything kept: Keep local history was turned off, or local history was cleared. */
  async clear(): Promise<void> {
    this.uses = []
    this.writing = this.writing.catch(() => undefined).then(() => rm(this.path, { force: true }))
    await this.writing
  }

  private async load(): Promise<PluginUse[]> {
    if (this.uses) return this.uses
    let uses: PluginUse[] = []
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      // An entry this version cannot read is dropped rather than failing the rest.
      if (parsed.success) uses = parsed.data.uses.flatMap(entry => { const use = pluginUseSchema.safeParse(entry); return use.success ? [use.data] : [] })
    } catch { /* No file yet, or one that cannot be read: an empty record. */ }
    this.uses ??= uses
    return this.uses
  }

  private save(): Promise<void> {
    const write = async (): Promise<void> => {
      const next = `${this.path}.next`
      await mkdir(dirname(this.path), { recursive: true })
      try {
        await writeFile(next, JSON.stringify({ version: 1, uses: this.uses ?? [] }), { mode: 0o600 })
        await rename(next, this.path)
      } catch (error) {
        await rm(next, { force: true })
        throw error
      }
    }
    // One write at a time, in order; a failed one does not stop the next.
    this.writing = this.writing.catch(() => undefined).then(write)
    return this.writing
  }
}
