import { createHash } from 'node:crypto'
import { link, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { defaultAgentConfiguration, type AgentAssignment, type AgentConfiguration, type AgentQueueItem } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentCredentials } from './credentials'

const RECOVERY_FILE = 'provider-retirement-v1.json'
const RETENTION_MS = 7 * 86_400_000
const recoverySchema = z.object({
  version: z.literal(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  migratedAt: z.number(), expiresAt: z.number(), state: z.record(z.string(), z.unknown()),
})
type Recovery = z.infer<typeof recoverySchema>
type RetirableState = {
  configuration: AgentConfiguration; assignments: AgentAssignment[]; queue: AgentQueueItem[]
  pendingRequest: string; contextSavedAt: number
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }

/** Disk compatibility only. The public configuration/IPC schema still rejects this field. */
export function stripRetiredEndpoint(value: object): Record<string, unknown> {
  const clean = { ...value } as Record<string, unknown>
  delete clean.endpoint
  return clean
}

function redact(state: Record<string, unknown>, historyEnabled: boolean, now: number): Record<string, unknown> {
  const clean = structuredClone(state)
  const cutoff = now - RETENTION_MS
  clean.assignments = (clean.assignments as AgentAssignment[]).map(assignment => ({ ...assignment,
    instruction: historyEnabled && assignment.contextUpdatedAt >= cutoff ? assignment.instruction : '',
    lastFailure: /^[a-f0-9]{64}$/u.test(assignment.lastFailure) ? assignment.lastFailure : '',
  }))
  clean.queue = (clean.queue as AgentQueueItem[]).filter(item => item.requestId || (historyEnabled && Date.parse(item.createdAt) > cutoff))
    .map(item => historyEnabled && Date.parse(item.createdAt) > cutoff ? item : { ...item, text: 'Open the original provider to review this pending request.' })
  if (!historyEnabled || Number(clean.contextSavedAt) < cutoff) clean.pendingRequest = ''
  return clean
}

async function readRecovery(path: string): Promise<Recovery | null> {
  try { return recoverySchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) { if (missing(error)) return null; throw error }
}

/** Recovery context has the same privacy policy as live state and a bounded lifetime. */
export async function maintainProviderRecovery(directory: string, historyEnabled: boolean, now = Date.now()): Promise<void> {
  const path = join(directory, RECOVERY_FILE)
  const recovery = await readRecovery(path)
  if (!recovery) return
  if (recovery.expiresAt <= now) { await unlink(path); return }
  const next = { ...recovery, state: redact(recovery.state, historyEnabled, now) }
  if (JSON.stringify(next) !== JSON.stringify(recovery)) {
    await new AtomicJsonStore(path, recoverySchema.parse, () => next).write(next)
  }
}

/** Publish a flushed recovery file exclusively; an interrupted temporary write cannot occupy its name. */
async function preserveRecovery(path: string, recovery: Recovery): Promise<void> {
  const stage = `${path}.stage`
  try {
    await new AtomicJsonStore(stage, recoverySchema.parse, () => recovery).write(recovery)
    await link(stage, path)
  } finally { await unlink(stage).catch(error => { if (!missing(error)) throw error }) }
}

/** Runs before strict parsing: an omitted provider in an existing file historically meant t3. */
export async function retireLegacyProvider<S extends RetirableState>(options: {
  directory: string; parse(input: unknown): S; historyEnabled: boolean
  credentials: Pick<AgentCredentials, 'has' | 'set'>; now?: number
}): Promise<void> {
  const now = options.now ?? Date.now()
  // Interrupted staging files never carry execution authority; remove their duplicate context on restart.
  const names = await readdir(options.directory).catch(error => { if (missing(error)) return []; throw error })
  for (const name of names) {
    if (name === `${RECOVERY_FILE}.stage` || name.startsWith(`${RECOVERY_FILE}.stage.tmp-`)) {
      await unlink(join(options.directory, name))
    }
  }
  const path = join(options.directory, 'agents.json')
  let bytes: string
  try { bytes = await readFile(path, 'utf8') }
  catch (error) {
    if (!missing(error)) throw error
    await maintainProviderRecovery(options.directory, options.historyEnabled, now)
    if (options.credentials.has('t3')) await options.credentials.set('t3', '')
    return
  }
  let raw: Record<string, unknown>
  try { raw = JSON.parse(bytes) } catch { return } // Ordinary corrupt-file recovery still owns invalid JSON.
  const configuration = raw?.configuration
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return
  const provider = (configuration as Record<string, unknown>).provider
  if (provider !== undefined && provider !== 't3') {
    await maintainProviderRecovery(options.directory, options.historyEnabled, now)
    if (options.credentials.has('t3')) await options.credentials.set('t3', '')
    return
  }
  // Validate all existing state before classifying it as a valid retired-provider save.
  const compatibleConfiguration = { ...defaultAgentConfiguration(), ...stripRetiredEndpoint(configuration), provider: 'codex' }
  const parsed = options.parse({ ...raw, configuration: compatibleConfiguration })
  const recoveryPath = join(options.directory, RECOVERY_FILE)
  const sourceDigest = createHash('sha256').update(bytes).digest('hex')
  const previous = await readRecovery(recoveryPath)
  if (previous && previous.sourceDigest !== sourceDigest) throw new Error('Existing provider recovery belongs to a different saved state. No provider was connected; keep both files for manual recovery.')
  const migratedAt = previous?.migratedAt ?? now
  const recovery: Recovery = { version: 1, sourceDigest, migratedAt, expiresAt: migratedAt + RETENTION_MS,
    state: redact({ ...parsed, configuration: { ...parsed.configuration, provider: provider ?? 't3',
      ...('endpoint' in configuration ? { endpoint: (configuration as Record<string, unknown>).endpoint } : {}) } }, options.historyEnabled, now) }
  if (!previous) await preserveRecovery(recoveryPath, recovery)
  else {
    // Keep durable evidence through live-state replacement even when a very late retry has expired.
    const retained = { ...previous, state: redact(previous.state, options.historyEnabled, now) }
    if (JSON.stringify(retained) !== JSON.stringify(previous)) await new AtomicJsonStore(recoveryPath, recoverySchema.parse, () => retained).write(retained)
  }
  const migrated = options.parse({ ...parsed,
    configuration: { ...parsed.configuration, provider: 'codex', enabled: false, defaultModelId: '' },
    providerUpgrade: { recoveryPath, migratedAt },
    assignments: [], queue: [], outbox: [], activeThreadId: null, activeProjectId: null,
    draftThreadId: null, draftRequestId: null, manualDraftId: null, deliveredDrafts: [], pendingRequest: '', composing: false,
  })
  // No secret is read, decrypted or archived. The vault's write is failure-atomic and preserves unrelated slots.
  if (options.credentials.has('t3')) await options.credentials.set('t3', '')
  await new AtomicJsonStore(path, options.parse, () => migrated).write(migrated)
  await maintainProviderRecovery(options.directory, options.historyEnabled, now)
}
