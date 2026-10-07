import { z } from 'zod'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from '../agents/threadToolServer'

/** The one name every client addresses the host setup tools by (ADR-0035). */
export const HOST_SETUP_MCP_SERVER = 'sotto_host_setup'
/** A host setup's own tools. A tool takes no target: the device is fixed when its setup starts. */
export const HOST_SETUP_TOOL_NAMES = ['host_status', 'host_check', 'host_add'] as const
export type HostSetupToolName = typeof HOST_SETUP_TOOL_NAMES[number]
/** A provider job's own tools (ADR-0035, amended for #461). Neither takes a target: the host and provider are fixed when the job starts. */
export const PROVIDER_JOB_TOOL_NAMES = ['provider_status', 'provider_check'] as const
export type ProviderJobToolName = typeof PROVIDER_JOB_TOOL_NAMES[number]
/** Every tool the server has; each thread is offered only its own job's. */
export type AgentJobToolName = HostSetupToolName | ProviderJobToolName
const TOOL_NAMES: readonly AgentJobToolName[] = [...HOST_SETUP_TOOL_NAMES, ...PROVIDER_JOB_TOOL_NAMES]
const noArguments = z.object({}).strict()
const descriptions: Record<AgentJobToolName, string> = {
  host_status: 'Read what Sotto knows about the one device this thread is setting up: its name, SSH target and port, the host installation and data folders, and the last check or add with the step it stopped at, its reason code and Add host\'s sentence. Takes no arguments.',
  host_check: 'Run Add host\'s own checks on this thread\'s device: reach it over SSH, wait for a Tailscale approval if Tailscale asks, sign in, check the host installation, and start the host if it is installed and not running. It pairs nothing and saves nothing. Returns ok, or the step it stopped at with a reason code, Add host\'s sentence, and a command that fixes it where there is one. SSH questions and Tailscale approvals are answered by the user in Settings > Hosts, and the call waits for them, up to 5 minutes. Takes no arguments. Run it first, and again after each fix.',
  host_add: 'Add this thread\'s device as a host in Sotto. Sotto first asks the user in this thread whether to add it, and the call waits for their answer; never answer or approve it yourself. If they agree, Sotto connects, starts the host if needed and pairs this computer, and saves the host only once it answers. Returns added, declined, or the step it stopped at with a reason code. Takes no arguments. Call it once host_check gets as far as starting the host.',
  provider_status: 'Read what Sotto knows about the one provider this thread is installing, updating or fixing on the one host it was started for: the host and its SSH target, the provider and the command that starts it, why the host cannot use it (not installed, too old, or installed but not found or not startable), the version the host found and the version Sotto needs, the host\'s own sentence, where the host looks for the command, and whether the host has found it. Takes no arguments.',
  provider_check: 'Have the host look for this thread\'s provider again and start it, the same as Check again on its tile in Settings > Hosts. It installs nothing and signs nothing in. Returns found when the host found the provider and could start it, which ends this job; otherwise why it still cannot use it. Takes no arguments. Call it after each fix.',
}
const definition = (name: AgentJobToolName): ThreadToolDefinition => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(noArguments, { io: 'input' }) as Record<string, unknown> })
export const hostSetupToolDefinitions: readonly ThreadToolDefinition[] = HOST_SETUP_TOOL_NAMES.map(definition)
export const providerJobToolDefinitions: readonly ThreadToolDefinition[] = PROVIDER_JOB_TOOL_NAMES.map(definition)
const allDefinitions = [...hostSetupToolDefinitions, ...providerJobToolDefinitions]
const INSTRUCTIONS = 'These tools work on the one host, or the one provider on one host, that this thread was started for, and nothing else. host_add asks the user in this thread and waits for their answer; never approve it yourself. If a call is interrupted or times out, read host_status or provider_status before running it again.'

/** One tool's answer: what it found, and whether that is a failure the agent should act on. */
export interface HostSetupToolReply { readonly result: Record<string, unknown>; readonly isError?: boolean }
/** What the tools ask of the jobs, for the thread that called. */
export interface HostSetupToolHandlers {
  /** Whether this Sotto thread runs an agent job now; every other thread is refused. */
  admits(threadId: string): boolean
  run(threadId: string, tool: AgentJobToolName): Promise<HostSetupToolReply>
  /** The tools this thread's job has, which is all it is offered. Every tool when absent. */
  tools?(threadId: string): readonly AgentJobToolName[]
}
/** One kind of agent job's side of the tools: whether a thread runs it, and its own tools. */
interface AgentJob<T extends AgentJobToolName> { admits(threadId: string): boolean; run(threadId: string, tool: T): Promise<HostSetupToolReply> }

/**
 * The two agent jobs over one server (ADR-0035): a host setup thread gets the host setup's tools, and a provider job's
 * thread the provider job's, and each tool goes to its own job, which refuses every thread but its own.
 */
export function agentJobTools(setup: AgentJob<HostSetupToolName>, job: AgentJob<ProviderJobToolName>): HostSetupToolHandlers {
  const isSetupTool = (tool: AgentJobToolName): tool is HostSetupToolName => (HOST_SETUP_TOOL_NAMES as readonly string[]).includes(tool)
  return {
    admits: threadId => setup.admits(threadId) || job.admits(threadId),
    tools: threadId => setup.admits(threadId) ? HOST_SETUP_TOOL_NAMES : job.admits(threadId) ? PROVIDER_JOB_TOOL_NAMES : [],
    run: (threadId, tool) => isSetupTool(tool) ? setup.run(threadId, tool) : job.run(threadId, tool),
  }
}

/**
 * `sotto_host_setup`: the loopback MCP server a host setup thread, or a provider job's thread, gets beside
 * `sotto_browser` (ADR-0035). Only a thread whose job is running is given a token, and a token is revoked when that job
 * ends, so every other thread's launch gets no server at all and an ended job's calls are refused. Each thread lists
 * and may call only its own job's tools.
 */
export class HostSetupToolServer implements ScopedThreadTools {
  readonly name = HOST_SETUP_MCP_SERVER
  /** Every tool, so a client's own allow-list covers whichever job a thread runs; `tools/list` gives each thread its own. */
  readonly definitions = allDefinitions
  /** A check or add can wait 5 minutes for a Tailscale approval. */
  readonly timeoutMs = 600_000
  private readonly server: ThreadToolServer
  constructor(private readonly handlers: HostSetupToolHandlers) {
    this.server = new ThreadToolServer({ name: HOST_SETUP_MCP_SERVER, serverName: 'sotto-host-setup', instructions: INSTRUCTIONS,
      unavailable: 'This host setup tool is unavailable.', failed: 'The host setup tool could not finish. Read host_status or provider_status before trying again.' },
    allDefinitions, (threadId, name, args) => this.invoke(threadId, name, args),
    threadId => { const own = this.own(threadId); return allDefinitions.filter(tool => own.includes(tool.name as AgentJobToolName)) })
  }
  /** This thread's server while its job runs; undefined for every other thread. */
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    if (!this.handlers.admits(threadId)) return undefined
    return this.server.mcpServer(threadId)
  }
  call(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> { return this.server.call(threadId, name, args) }
  revoke(threadId: string): void { this.server.revoke(threadId) }
  close(): Promise<void> { return this.server.close() }
  private own(threadId: string): readonly AgentJobToolName[] { return this.handlers.tools?.(threadId) ?? TOOL_NAMES }
  private async invoke(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> {
    const text = (value: unknown, isError = false): ThreadToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) })
    if (!this.handlers.admits(threadId)) return text({ message: 'This thread is not running a host setup or a provider job now. Nothing was checked, changed or added.' }, true)
    const tool = this.own(threadId).find(item => item === name)
    if (!tool) return text({ message: 'This tool is not part of this thread\'s job. Nothing was checked, changed or added.' }, true)
    if (!noArguments.safeParse(args).success) return text({ message: 'This tool takes no arguments. The host and the provider are fixed when the job starts.' }, true)
    const reply = await this.handlers.run(threadId, tool)
    return text(reply.result, reply.isError === true)
  }
}
