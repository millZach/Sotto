import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { ThreadStore } from '../../src/main/agents/threadStore'

/** Copy a consistent SQLite snapshot, including committed WAL data, without writing to the live profile. */
export async function copyPerfHistory(source: string, destination: string): Promise<void> {
  const path = join(source, 'threads.sqlite')
  try { await access(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // Profiles from before the history migration.
    throw error
  }
  const live = new DatabaseSync(path, { readOnly: true })
  try { await backup(live, join(destination, 'threads.sqlite')) } finally { live.close() }
}

/** Performance fixtures need the history beside workspace organization, just as the real host does. */
export async function hydratePerfHistory(host: AgentHostSnapshot, directory: string): Promise<void> {
  const path = join(directory, 'threads.sqlite')
  try { await access(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const store = new ThreadStore(path)
  store.open()
  try {
    for (const thread of host.threads) thread.messages = store.readMessages(thread.id).messages
  } finally { store.close() }
}
