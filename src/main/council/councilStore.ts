import { constants } from 'node:fs'
import { copyFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicJsonStore, hasErrorCode } from '../storage/atomicJsonStore'
import { councilFileSchema, legacyCouncilFileSchema, migrateCouncilFile, type CouncilFile } from './councilRecord'

/** Recognize versions before ordinary corrupt-JSON recovery can replace valuable history. */
export class CouncilStore {
  private readonly file: string
  private readonly store: AtomicJsonStore<CouncilFile>
  private backupMayExist = true
  constructor(directory: string) {
    this.file = join(directory, 'councils.json')
    this.store = new AtomicJsonStore(this.file, input => councilFileSchema.parse(input), () => ({ version: 2, councils: [] }))
  }
  async read(): Promise<CouncilFile> {
    let bytes: string
    try { bytes = await readFile(this.file, 'utf8') }
    catch (error) { if (hasErrorCode(error, 'ENOENT')) return { version: 2, councils: [] }; throw error }
    const input: unknown = JSON.parse(bytes)
    if (typeof input !== 'object' || input === null || !('version' in input)) throw new Error('Council history has no file version.')
    if (input.version === 2) return councilFileSchema.parse(input)
    if (input.version !== 1) throw new Error('This Council history needs a newer Sotto. Its file was kept unchanged.')
    const migrated = councilFileSchema.parse(migrateCouncilFile(legacyCouncilFileSchema.parse(input)))
    // Keep the original bytes. A failed backup or atomic write leaves the original history in place.
    await copyFile(this.file, `${this.file}.v1-backup`, constants.COPYFILE_EXCL).catch(async (error: unknown) => {
      if (!hasErrorCode(error, 'EEXIST')) throw error
      if (await readFile(`${this.file}.v1-backup`, 'utf8') !== bytes) throw new Error('A different Council migration backup already exists. Council history was kept unchanged.')
    })
    await this.store.write(migrated)
    return migrated
  }
  async writeLatest(latest: () => CouncilFile, keepHistory = true): Promise<void> {
    await this.store.writeLatest(latest)
    if (!keepHistory && this.backupMayExist) {
      // The backup must not retain words after the current history-off record has safely replaced them.
      await rm(`${this.file}.v1-backup`, { force: true })
      this.backupMayExist = false
    }
  }
}
