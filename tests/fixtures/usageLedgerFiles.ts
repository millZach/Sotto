import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Every thread's saved usage ledger under `root`, by thread, from the files each thread's ledger has of its own (#555). */
export async function savedUsageLedgers(root: string, provider: 'claude' | 'codex' | 'grok' = 'claude'): Promise<Record<string, unknown>> {
  const directory = join(root, `${provider}-usage`)
  // Ledger files alone: a write still on its way is a temporary file beside them, not yet the thread's.
  const names = (await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error }))
    .filter(name => /^[0-9a-f]{40}\.json$/u.test(name))
  const files = await Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as { id: string; ledger: unknown }))
  return Object.fromEntries(files.map(file => [file.id, file.ledger]))
}

/**
 * Writes the ledgers saved under `root` as the one file an earlier build kept them in, `{provider}-usage.json` beside the
 * threads' own files, and gives its path: a seed both an earlier build and this one read.
 */
export async function writeOneUsageFile(root: string, provider: 'claude' | 'codex' | 'grok' = 'claude'): Promise<string> {
  const path = join(root, `${provider}-usage.json`)
  await writeFile(path, JSON.stringify(await savedUsageLedgers(root, provider)))
  return path
}

/** The bytes the usage ledgers under `root` take on disk: the one file of an earlier build and every thread's own file. */
export async function usageLedgerBytes(root: string, provider: 'claude' | 'codex' | 'grok' = 'claude'): Promise<number> {
  const one = await stat(join(root, `${provider}-usage.json`)).then(file => file.size, () => 0)
  const directory = join(root, `${provider}-usage`)
  const names = await readdir(directory).catch(() => [] as string[])
  const sizes = await Promise.all(names.map(name => stat(join(directory, name)).then(file => file.size)))
  return sizes.reduce((sum, size) => sum + size, one)
}
