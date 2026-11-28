import { createHash } from 'node:crypto'
import { mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { EXAMPLE_PLAYBOOK, EXAMPLE_PLAYBOOK_ID, PLAYBOOK_BYTES_MAX, PLAYBOOK_EXTENSION, PLAYBOOK_ID_PATTERN, PLAYBOOKS_FOLDER, PLAYBOOKS_MAX, playbookSchema, type Playbook } from '../../shared/playbooks'
import { hasErrorCode } from '../storage/atomicJsonStore'

/**
 * The playbooks folder in Sotto's data folder (ADR-0218): one JSON file per playbook, named for its id, written by the
 * user. Sotto reads it when Settings › Scheduled tasks reads its state and when a run is made, never runs a file it can't
 * read whole, and keeps a hash of each file's bytes as its revision.
 */

export interface PlaybookFile {
  readonly id: string
  readonly playbook?: Playbook
  readonly revision?: string
  /** Why the file can't run, in plain words. */
  readonly problem?: string
}

export const playbooksFolder = (directory: string): string => join(directory, PLAYBOOKS_FOLDER)

/** A file's revision: the start of the SHA-256 of its bytes, enough to tell two versions apart. */
export const playbookRevision = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

async function readCapped(path: string): Promise<Buffer | 'too-large'> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(PLAYBOOK_BYTES_MAX + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > PLAYBOOK_BYTES_MAX ? 'too-large' : buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}

/** One file, read and checked. */
export async function readPlaybook(path: string): Promise<PlaybookFile> {
  const id = basename(path, PLAYBOOK_EXTENSION)
  if (!PLAYBOOK_ID_PATTERN.test(id)) {
    const invalidId = `invalid:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`
    return { id: invalidId, problem: `Rename ${JSON.stringify(basename(path))} using lowercase letters, digits and dashes, such as triage-and-fix.json.` }
  }
  let bytes: Buffer | 'too-large'
  try { bytes = await readCapped(path) } catch { return { id, problem: 'Its file could not be read.' } }
  if (bytes === 'too-large') return { id, problem: 'Its file is longer than 128 KB.' }
  const revision = playbookRevision(bytes)
  let input: unknown
  try { input = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')) } catch { return { id, revision, problem: 'Its file is not valid JSON.' } }
  const parsed = playbookSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    return { id, revision, problem: issues.join(' ') }
  }
  return { id, revision, playbook: parsed.data }
}

/** Every playbook in the folder, by id; a missing folder holds none. */
export async function readPlaybooks(folder: string): Promise<PlaybookFile[]> {
  let names: string[]
  try { names = await readdir(folder) } catch (error) { if (hasErrorCode(error, 'ENOENT')) return []; throw error }
  const files = names.filter(name => name.endsWith(PLAYBOOK_EXTENSION)).sort().slice(0, PLAYBOOKS_MAX)
  return await Promise.all(files.map(name => readPlaybook(join(folder, name))))
}

/** Writes the example playbook into the folder, keeping a file of that name the user already has. Resolves with its id. */
export async function addExamplePlaybook(folder: string): Promise<string> {
  await mkdir(folder, { recursive: true })
  try { await writeFile(join(folder, `${EXAMPLE_PLAYBOOK_ID}${PLAYBOOK_EXTENSION}`), `${JSON.stringify(EXAMPLE_PLAYBOOK, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }) }
  catch (error) { if (!hasErrorCode(error, 'EEXIST')) throw error }
  return EXAMPLE_PLAYBOOK_ID
}
