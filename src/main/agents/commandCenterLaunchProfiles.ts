import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { commandCenterRecordSchema } from '../../shared/commandCenter'
import type { AgentThread } from '../../shared/agents'
import type { ProviderId } from '../../shared/agents'
import type { CommandCenterProfileTools, ThreadLaunchProfiles, CommandCenterLaunchProfile } from './host'
import { CommandCenterProfileRefusal, validateCommandCenterProfile } from './commandCenterProfile'

const savedIdentity = z.object({ commandCenter: commandCenterRecordSchema.optional() })
const IDENTITY_FAILURE = 'The command center’s saved identity could not be verified. Nothing was sent. Restart Sotto to recover.'

/** Reads only durable main-owned identity. Thread kind corroborates it and can never grant it. */
export class CommandCenterLaunchProfiles implements ThreadLaunchProfiles {
  private tools: CommandCenterProfileTools | undefined
  private readonly revoked = new Map<string, string>()
  constructor(private readonly directory: string, private readonly hostId: () => string | undefined,
    private readonly thread: (id: string) => AgentThread | undefined) {}

  useTools(tools: CommandCenterProfileTools): void {
    if (tools.name !== 'sotto_threads') throw new CommandCenterProfileRefusal('The command center needs its own Sotto tool server.')
    this.tools = tools
  }
  /** Recovery can recreate only the binding named by the durable identity. */
  async assertCreationBinding(threadId: string, projectId: string, provider: ProviderId | undefined): Promise<void> {
    try {
      const current = savedIdentity.parse(JSON.parse(await readFile(join(this.directory, 'agents.json'), 'utf8'))).commandCenter?.current
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
    let saved: z.infer<typeof savedIdentity>
    try { saved = savedIdentity.parse(JSON.parse(await readFile(join(this.directory, 'agents.json'), 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (!thread?.kind || thread.kind === 'project')) return undefined
      throw new CommandCenterProfileRefusal(IDENTITY_FAILURE)
    }
    const record = saved.commandCenter
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
    const latest = savedIdentity.parse(JSON.parse(await readFile(join(this.directory, 'agents.json'), 'utf8'))).commandCenter?.current
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
