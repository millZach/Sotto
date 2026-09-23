import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { agentHostSnapshotSchema, type AgentHostSnapshot } from '../../shared/agents'

const identitySchema = z.object({ hostId: z.uuid() }).strict()
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** A corrupt or inaccessible identity is a startup error, never a reason to replace the host. */
export async function loadHostIdentity(directory: string): Promise<string> {
  const path = join(directory, 'host.json')
  const read = async (): Promise<string> => identitySchema.parse(JSON.parse(await readFile(path, 'utf8'))).hostId
  try { return await read() } catch (error) { if (!missing(error)) throw error }
  await mkdir(directory, { recursive: true })
  const hostId = randomUUID()
  const temporary = join(directory, `host.json.tmp-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ hostId })}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    // Publishing an already-complete file with an exclusive link makes concurrent first starts
    // converge on one identity. rename would replace the first host's identity on POSIX.
    try { await link(temporary, path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return await read()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

export function stampHostSnapshot(snapshot: AgentHostSnapshot, hostId: string): AgentHostSnapshot {
  return { ...snapshot, hostId,
    projects: snapshot.projects.map(project => ({ ...project, hostId })),
    threads: snapshot.threads.map(thread => ({ ...thread, hostId })) }
}

/** Validate the complete old snapshot before the atomic replacement; preserve every other field. */
export async function migrateWorkspaceHost(directory: string, hostId: string): Promise<void> {
  identitySchema.parse({ hostId })
  const path = join(directory, 'workspace.json')
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) { if (missing(error)) return; throw error }
  const workspace = z.object({ snapshot: agentHostSnapshotSchema }).passthrough().parse(JSON.parse(raw))
  const snapshot = workspace.snapshot
  const identities = [snapshot.hostId, ...snapshot.projects.map(project => project.hostId), ...snapshot.threads.map(thread => thread.hostId)]
  if (identities.some(id => id !== undefined && id !== hostId)) throw new Error('This workspace belongs to another host. Restore its original host identity before starting Sotto.')
  if (identities.every(id => id === hostId)) return
  // Keep unknown snapshot/entity fields intact during this identity-only migration.
  const original = JSON.parse(raw) as { snapshot: AgentHostSnapshot }
  const next = { ...original, snapshot: stampHostSnapshot(original.snapshot, hostId) }
  await new AtomicJsonStore(path, value => value, () => next).write(next)
}
