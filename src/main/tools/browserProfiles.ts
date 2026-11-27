import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { BROWSER_PROFILES_MAX, browserProfileSchema, type BrowserProfile } from '../../shared/browser'

const profilesFileSchema = z.object({ version: z.literal(1), profiles: z.array(browserProfileSchema).max(BROWSER_PROFILES_MAX) }).strict()
const PARTITION_PREFIX = 'sotto-profile-'

/** The persistent session a profile's pages share; Electron keeps it under `Partitions/` in Sotto's data folder. */
export const profilePartition = (id: string): string => `persist:${PARTITION_PREFIX}${id}`

/** A refusal the user reads as it is. */
export class ProfileProblem extends Error {}

/**
 * The user's browser profiles (ADR-0221): names and IDs in one small file in Sotto's data folder, which only the user's
 * own actions in the pane change. No agent tool reads or writes it. Each profile's sign-ins live in its Electron
 * partition, never in this file.
 */
export class BrowserProfiles {
  private cache: BrowserProfile[] | null = null
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}

  async list(): Promise<BrowserProfile[]> {
    if (this.cache) return [...this.cache]
    try {
      const parsed = profilesFileSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')))
      this.cache = parsed.success ? parsed.data.profiles : []
    } catch { this.cache = [] }
    return [...this.cache]
  }

  async find(id: string): Promise<BrowserProfile | undefined> { return (await this.list()).find(profile => profile.id === id) }

  add(name: string): Promise<BrowserProfile> { return this.serial(async () => {
    const profiles = await this.list()
    if (profiles.length >= BROWSER_PROFILES_MAX) throw new ProfileProblem(`Remove a profile before adding another (${BROWSER_PROFILES_MAX} at most).`)
    const trimmed = name.trim()
    if (profiles.some(profile => profile.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) throw new ProfileProblem('A profile already has that name. Choose another.')
    const profile = browserProfileSchema.parse({ id: randomUUID(), name: trimmed })
    await this.write([...profiles, profile])
    return profile
  }) }

  remove(id: string): Promise<BrowserProfile | null> { return this.serial(async () => {
    const profiles = await this.list()
    const removed = profiles.find(profile => profile.id === id) ?? null
    if (removed) await this.write(profiles.filter(profile => profile !== removed))
    return removed
  }) }

  /**
   * Deletes the partition folders no profile names any more, before any session opens them: a removed profile's data,
   * which Chromium may still hold open while Sotto runs, goes at the next start.
   */
  async sweepPartitions(userDataPath: string): Promise<void> {
    const kept = new Set((await this.list()).map(profile => `${PARTITION_PREFIX}${profile.id}`))
    const folder = join(userDataPath, 'Partitions')
    let names: string[]
    try { names = await readdir(folder) } catch { return }
    await Promise.all(names.filter(name => name.startsWith(PARTITION_PREFIX) && !kept.has(name))
      .map(name => rm(join(folder, name), { recursive: true, force: true }).catch(() => undefined)))
  }

  private async write(profiles: BrowserProfile[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, profiles }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, this.file)
    this.cache = profiles
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }
}
