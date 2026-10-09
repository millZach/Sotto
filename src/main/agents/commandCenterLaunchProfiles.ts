import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { commandCenterRecordSchema, type CommandCenterRecord } from '../../shared/commandCenter'
import type { AgentThread } from '../../shared/agents'
import type { ProviderId } from '../../shared/agents'
import type { CommandCenterProfileTools, ThreadLaunchProfiles, CommandCenterLaunchProfile } from './host'
import { CommandCenterProfileRefusal, validateCommandCenterProfile } from './commandCenterProfile'
import { migrateCommandCenterRecord } from './commandCenterRecords'

const savedIdentity = z.object({ commandCenter: z.preprocess(migrateCommandCenterRecord, commandCenterRecordSchema) })
type Identity = Pick<CommandCenterRecord, 'current' | 'creation' | 'history'>
const IDENTITY_FAILURE = 'The command center’s saved identity could not be verified. Nothing was sent. Restart Sotto to recover.'

/** Reads only durable main-owned identity. Thread kind corroborates it and can never grant it. */
export class CommandCenterLaunchProfiles implements ThreadLaunchProfiles {
  private tools: CommandCenterProfileTools | undefined
  private readonly revoked = new Map<string, string>()
  private cached: { signature: string; identity: Identity | undefined } | undefined
  /** Previous valid identity is evidence for refusal only, never permission to launch. */
  private lastKnown: Identity | undefined
  private readTail: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string, private readonly hostId: () => string | undefined,
    private readonly thread: (id: string) => AgentThread | undefined) {}

  private async signature(): Promise<string> {
    const file = await stat(join(this.directory, 'agents.json'), { bigint: true })
    // AtomicJsonStore syncs a fresh file, then renames it over the destination. Include its
    // identity as well as nanosecond times/size so same-size replacements invalidate the cache.
    return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs, file.birthtimeNs].join(':')
  }
  private identity(): Promise<Identity> {
    // Concurrent workspace/adapter checks share the read rather than parse the same file twice.
    const reading = this.readTail.then(() => this.readIdentity())
    this.readTail = reading.then(() => undefined, () => undefined)
    return reading
  }
  private async readIdentity(): Promise<Identity> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const signature = await this.signature()
      if (this.cached?.signature === signature) {
        if (!this.cached.identity) throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
        return this.cached.identity
      }
      let identity: Identity | undefined
      try {
        const record = savedIdentity.parse(JSON.parse(await readFile(join(this.directory, 'agents.json'), 'utf8'))).commandCenter
        identity = { current: record.current, creation: record.creation, history: record.history }
      } catch { /* Invalid/unreadable data cannot confer a profile. Keep lastKnown only for refusal. */ }
      // Do not associate a read of the old file with a replacement's signature, or admit an
      // identity superseded while reading. A continuously changing file refuses this check.
      if (signature !== await this.signature()) continue
      this.cached = { signature, identity }
      if (!identity) throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
      this.lastKnown = identity
      return identity
    }
    throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
  }
  private namedByLastIdentity(threadId: string): boolean {
    return this.lastKnown?.current?.target.threadId === threadId
      || this.lastKnown?.creation?.identity.target.threadId === threadId
      || this.lastKnown?.history.some(identity => identity.target.threadId === threadId) === true
  }

  useTools(tools: CommandCenterProfileTools): void {
    if (tools.name !== 'sotto_threads') throw new CommandCenterProfileRefusal('The command center needs its own Sotto tool server.')
    this.tools = tools
  }
  /** Recovery can recreate only the binding named by the durable identity. */
  async assertCreationBinding(threadId: string, projectId: string, provider: ProviderId | undefined): Promise<void> {
    try {
      const current = (await this.identity()).current
      if (!current || current.target.threadId !== threadId || current.target.hostId !== this.hostId()
        || current.projectId !== projectId || current.provider !== provider) throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
    } catch { throw new CommandCenterProfileRefusal(IDENTITY_FAILURE) }
  }

  async profileFor(threadId: string): Promise<CommandCenterLaunchProfile | undefined> {
    try { return await this.resolveProfile(threadId) }
    catch (error) {
      try { this.tools?.revoke(threadId) } catch { /* A broken server cleanup never admits a profile. */ }
      throw error instanceof CommandCenterProfileRefusal ? error : new CommandCenterProfileRefusal(IDENTITY_FAILURE)
    }
  }
  private async resolveProfile(threadId: string): Promise<CommandCenterLaunchProfile | undefined> {
    const thread = this.thread(threadId)
    let record: Identity
    try { record = await this.identity() }
    catch {
      if ((!thread?.kind || thread.kind === 'project') && !this.namedByLastIdentity(threadId)) return undefined
      throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
    }
    const current = record?.current
    if (record?.history.some(identity => identity.target.threadId === threadId) || thread?.kind === 'command-center-history') {
      throw new CommandCenterProfileRefusal('This earlier command center is read only history. Open the current command center to continue.')
    }
    if (current?.target.threadId !== threadId) {
      if (thread?.kind === 'command-center' || record?.creation?.identity.target.threadId === threadId) throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
      return undefined
    }
    if (current.target.hostId !== this.hostId() || thread && (thread.kind !== 'command-center'
      || thread.projectId !== current.projectId || thread.providerId !== current.provider)) throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
    const reason = this.revoked.get(threadId)
    if (reason) throw new CommandCenterProfileRefusal(reason)
    const tools = this.tools
    if (!tools) throw new CommandCenterProfileRefusal('The command center’s tool server is unavailable. Nothing was sent. Reopen the command center to try again.')
    const server = await tools.mcpServer(threadId)
    if (!server) throw new CommandCenterProfileRefusal('The command center’s tools are no longer admitted. Nothing was sent. Reopen the command center to recover.')
    // Admission may have waited on starting HTTP. A replacement cannot borrow this previous identity.
    const latest = (await this.identity()).current
    if (JSON.stringify(latest) !== JSON.stringify(current)) throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
    const profile: CommandCenterLaunchProfile = Object.freeze({ kind: 'command-center',
      server: Object.freeze({ ...server, headers: Object.freeze(server.headers.map(header => Object.freeze({ ...header }))) }),
      toolNames: Object.freeze(tools.definitions.map(tool => tool.name)),
      revoke: (failure: string): void => { this.revoked.set(threadId, failure); tools.revoke(threadId) },
    })
    validateCommandCenterProfile(profile)
    return profile
  }
}
