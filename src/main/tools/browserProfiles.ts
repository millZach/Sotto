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

const UNREADABLE = 'Sotto could not read its list of browser profiles, so it changes nothing there and every profile keeps its sign-ins. Restart Sotto to try again.'

/** What a read of the file found: its profiles, and whether Sotto may write the file and sweep partitions by it. */
interface ProfilesRead { readonly profiles: BrowserProfile[]; readonly trusted: boolean }

/**
 * The profiles a file Sotto cannot take whole still names, one by one, so their pages still open. Such a file is never
 * written or swept by: a newer Sotto's, or one damaged, holds profiles this one cannot see.
 */
function readable(value: unknown): BrowserProfile[] {
  const listed = (value as { profiles?: unknown } | null)?.profiles
  if (!Array.isArray(listed)) return []
  return listed.flatMap(entry => { const parsed = browserProfileSchema.safeParse(entry); return parsed.success ? [parsed.data] : [] }).slice(0, BROWSER_PROFILES_MAX)
}

/**
 * The user's browser profiles (ADR-0221): names and IDs in one small file in Sotto's data folder, which only the user's
 * own actions in the pane change. No agent tool reads or writes it. Each profile's sign-ins live in its Electron
 * partition, never in this file.
 */
export class BrowserProfiles {
  /** The last read of a file Sotto could take whole, or found missing; a read that failed is tried again next time. */
  private cache: BrowserProfile[] | null = null
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}

  async list(): Promise<BrowserProfile[]> { return [...(await this.read()).profiles] }

  /**
   * Only a missing file is no profiles. A file that fails to read, or that is not one this Sotto wrote whole, lists the
   * profiles it can and is trusted for nothing else: no write replaces it and no sweep deletes by it (ADR-0221).
   */
  private async read(): Promise<ProfilesRead> {
    if (this.cache) return { profiles: this.cache, trusted: true }
    let text: string
    try { text = await readFile(this.file, 'utf8') } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') return { profiles: [], trusted: false }
      this.cache = []
      return { profiles: this.cache, trusted: true }
    }
    let value: unknown
    try { value = JSON.parse(text) } catch { return { profiles: [], trusted: false } }
    const parsed = profilesFileSchema.safeParse(value)
    if (!parsed.success) return { profiles: readable(value), trusted: false }
    this.cache = parsed.data.profiles
    return { profiles: this.cache, trusted: true }
  }

  /** Refuses in words while the file cannot be trusted, before anything about a profile changes. */
  async writable(): Promise<void> {
    if (!(await this.read()).trusted) throw new ProfileProblem(UNREADABLE)
  }

  async find(id: string): Promise<BrowserProfile | undefined> { return (await this.list()).find(profile => profile.id === id) }

  add(name: string): Promise<BrowserProfile> { return this.serial(async () => {
    await this.writable()
    const profiles = await this.list()
    if (profiles.length >= BROWSER_PROFILES_MAX) throw new ProfileProblem(`Remove a profile before adding another (${BROWSER_PROFILES_MAX} at most).`)
    const trimmed = name.trim()
    if (profiles.some(profile => profile.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) throw new ProfileProblem('A profile already has that name. Choose another.')
    const profile = browserProfileSchema.parse({ id: randomUUID(), name: trimmed })
    await this.write([...profiles, profile])
    return profile
  }) }

  remove(id: string): Promise<BrowserProfile | null> { return this.serial(async () => {
    await this.writable()
    const profiles = await this.list()
    const removed = profiles.find(profile => profile.id === id) ?? null
    if (removed) await this.write(profiles.filter(profile => profile !== removed))
    return removed
  }) }

  /**
   * Deletes the partition folders no profile names any more, before any session opens them: a removed profile's data,
   * which Chromium may still hold open while Sotto runs, goes at the next start. With a file it cannot trust, it deletes
   * nothing: a profile it cannot read is still the user's.
   */
  async sweepPartitions(userDataPath: string): Promise<void> {
    const read = await this.read()
    if (!read.trusted) return
    const kept = new Set(read.profiles.map(profile => `${PARTITION_PREFIX}${profile.id}`))
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
