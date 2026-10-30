import { z } from 'zod'
import { CANCEL_DELEGATION_TOOL, cancelDelegationInputSchema, DELEGATE_MCP_SERVER, DELEGATE_TOOL, delegateInputSchema, DELEGATION_PROMPTS_PER_THREAD,
  DELEGATION_WAIT_MAX_SECONDS, LIST_MACHINES_TOOL, READ_DELEGATION_TOOL, readDelegationInputSchema } from '../../shared/delegation'
import { WORKING_THREADS_QUIET_MAX } from '../../shared/workingThreads'
import { WATCHER_REPLY_BYTES_MAX } from '../../shared/watcher'
import { NOT_ADMITTED, type DelegationService } from './delegation'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolCallContext, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'

const schema = (input: z.ZodType): Record<string, unknown> => z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>
/** With worker roles on (#1041), what a new thread starts on comes from its kind of work unless the call names it. */
const USE_THE_ROLE = 'Leave it out to use the role.'
const delegateByRoleSchema = delegateInputSchema.extend({
  provider: delegateInputSchema.shape.provider.describe(`For a new thread: claude, codex, grok, muse or devin, named with model. ${USE_THE_ROLE}`),
  model: delegateInputSchema.shape.model.describe(`For a new thread: a ready model ID of that provider, named with provider. ${USE_THE_ROLE}`),
  effort: delegateInputSchema.shape.effort.describe(`For a new thread: a reasoning effort the model offers. ${USE_THE_ROLE}`),
  permission: delegateInputSchema.shape.permission.describe(`For a new thread: approval-required, auto-accept-edits, auto or full-access. ${USE_THE_ROLE} Never wider than this thread's own or the user's new-thread default.`),
})
const NEW_THREAD_BY_NAME = `For a new thread name the provider, model, effort and permission; call ${READ_DELEGATION_TOOL} with no delegation to see what is ready. The permission may be no wider than this thread's or the user's new-thread default.`
const NEW_THREAD_BY_ROLE = `For a new thread name the kind of work and leave out provider, model, effort and permission: Sotto starts the thread on what the user's Settings give that worker role, within what this thread and the user's new-thread default allow. Name them only when the user asked for something else for this request; what you name overrides the role for this delegation, and the result says so. Call ${READ_DELEGATION_TOOL} with no delegation to see what each role starts on.`

/** With Work across machines on (#1032), a new thread may name a machine or a system, and the thread may list the machines. */
const WHERE = `A new thread starts on This computer. Name machine, from ${LIST_MACHINES_TOOL}, or os (windows, macos or linux) when the work needs one: Sotto starts it on that machine, which admits it under the user's own rules, and only while that machine is connected; otherwise it is refused and nothing is queued. A system never falls back to another. from_my_branch and test_run work there too: your branch, or a check's snapshot, goes to that machine first, and a check waits in that machine's own queue. The result's placement says where it started.`
/** With Work across machines on (#1033), a new thread may start from this thread's branch, and say it is a test run. */
const FROM_MY_BRANCH = 'Set from_my_branch to start a new thread in its own worktree on your branch, with your commits; uncommitted work refuses it. Set test_run too when the thread is there to run tests: your uncommitted work then goes as a snapshot, and nothing in your own working copy changes. The result\'s startedFrom says where it started and what the snapshot carried.'
/**
 * A check, one at a time per machine (#1312): what a delegating thread is told of the queue and of the reply it asks for.
 * The reply is the contract; Sotto passes it on as the thread's words and reads no verdict from it.
 */
const CHECKS = `Set test_run for any thread that is there to run tests, which the user calls a check. One check runs at a time on a machine: a later one waits its turn, in the order asked, with its outcome working and the result's check saying how many are ahead, and its snapshot is taken when you ask, not when it starts. cancel_delegation takes a waiting check out of the queue. In a check's brief, ask its thread to reply first with the verdict, the counts and the failing lines, inside ${WATCHER_REPLY_BYTES_MAX / 1024} KiB, since a longer reply is cut there; the full log stays in its own history. Sotto passes that reply on as the thread's words and never reads pass or fail from it.`
/**
 * A check on a headless host (#1312): it waits in that machine's own queue, shared with the desktop Watcher's checks there.
 * With from_my_branch, a snapshot of the thread's uncommitted work goes with it (#1316 part 2).
 */
const CHECKS_HOST = `Set test_run for any thread that is there to run tests, which the user calls a check. One check runs at a time on this machine, yours and Watcher's alike: a later one waits its turn, in the order asked, with its outcome working and the result's check saying how many are ahead. cancel_delegation takes a waiting check out of the queue. In a check's brief, ask its thread to reply first with the verdict, the counts and the failing lines, inside ${WATCHER_REPLY_BYTES_MAX / 1024} KiB, since a longer reply is cut there; the full log stays in its own history. Sotto passes that reply on as the thread's words and never reads pass or fail from it.`
/** What starting from this thread's branch adds to a delegation (#1033), offered while Work across machines is on, on a host too (#1316 part 2). */
const FROM_BRANCH_FIELDS = { from_my_branch: true, test_run: true } as const
/** What Work across machines adds to a delegation (#1032, #1033), none of it offered while that is off. */
const ACROSS_MACHINES = { machine: true, os: true, ...FROM_BRANCH_FIELDS } as const
const delegateSingleByRoleSchema = delegateByRoleSchema.omit({ count: true, prompts: true })
const delegateSingleSchema = delegateInputSchema.omit({ count: true, prompts: true })
const delegateRoleHereSchema = delegateByRoleSchema.omit(ACROSS_MACHINES)
const delegateHereSchema = delegateInputSchema.omit(ACROSS_MACHINES)
const delegateSingleRoleHereSchema = delegateSingleByRoleSchema.omit(ACROSS_MACHINES)
const delegateSingleHereSchema = delegateSingleSchema.omit(ACROSS_MACHINES)
/** A thread on a headless host (#1310) delegates only on its own machine until #1316. */
const WHERE_HOST = `A new thread starts on this machine, the one this thread runs on. A thread here delegates only to threads on this machine for now, so a machine or os (windows, macos or linux) other than this machine's own is refused. The result's placement says where it started.`
/** With the desktop relay (#1316), a thread on a headless host may start a thread on This computer too, while it is connected. */
const WHERE_HOST_RELAY = `A new thread starts on this machine, the one this thread runs on. Name machine, from ${LIST_MACHINES_TOOL}, or os (windows, macos or linux) to start it elsewhere: Sotto asks This computer, which starts it on This computer or on another machine it is connected to, under the user's own rules, and only while This computer is connected to this machine; otherwise it is refused and nothing is queued. from_my_branch and test_run work there too: This computer moves your branch, or a check's snapshot, to that machine first, and a check waits in that machine's own queue. A system never falls back to another. The result's placement says where it started.`
const LIST_MACHINES_INPUT = z.object({}).strict()
/** Where the delegating thread runs: This computer, the desktop, or a headless host's machine (#1310). */
export type DelegationPlace = 'this-computer' | 'this-machine'

/**
 * The tools a delegating thread is offered: with worker roles on, a new thread's model comes from its kind of work; with
 * Work across machines on (#1032), a new thread may name a machine or a system, and the machines can be listed. On a
 * headless host (`this-machine`, #1310), the words say this machine, and only this machine is listed.
 */
export function delegationToolDefinitions(roles: boolean, machines = false, place: DelegationPlace = 'this-computer', relay = false, swarms = false): readonly ThreadToolDefinition[] {
  const delegate = roles
    ? swarms ? machines ? delegateByRoleSchema : delegateRoleHereSchema : machines ? delegateSingleByRoleSchema : delegateSingleRoleHereSchema
    : swarms ? machines ? delegateInputSchema : delegateHereSchema : machines ? delegateSingleSchema : delegateSingleHereSchema
  const here = place === 'this-machine' ? 'this machine' : 'this computer'
  return [
    { name: DELEGATE_TOOL, inputSchema: schema(delegate), description: [
      `Hand work to another thread on ${here}: start a new Sotto thread on any provider with your brief, or send another brief to a thread you delegated to.`,
      'The thread is the user\'s to open, answer and stop. It asks the user, never you, for any permission or answer, and nothing you send approves anything.',
      roles ? NEW_THREAD_BY_ROLE : NEW_THREAD_BY_NAME,
      `It waits up to wait_seconds (at most ${DELEGATION_WAIT_MAX_SECONDS}) for the outcome and returns the reply once answered. When the wait ends first it returns working, and Sotto sends this thread a wake-up, with the reply once answered, when the outcome changes: end your turn or carry on, and do not poll.`,
      swarms ? `Count starts that many distinct angle workers and one lead on the role's model. Each angle has its own worktree. Name prompts for the angles, or let the lead plan them. Read each role's usual and up-to counts in read_delegation: use Usual unless distinct angles help, and stay within Up to unless the user names a count, which overrides them. The machine ceiling queues extras in order; the receipt says how many wait and gives the cost shape, count × effort plus the lead. Reuse one retry_key for the whole swarm. Leave count out for one worker.`
        : `Sotto starts any number of threads. When more than ${WORKING_THREADS_QUIET_MAX} threads are working on ${here} after a start, the result carries a warning: tell the user what it says.`,
      `Each thread takes ${DELEGATION_PROMPTS_PER_THREAD} briefs per user message to this thread; retries and wake-ups renew nothing.`,
      ...machines ? place === 'this-machine' ? [relay ? WHERE_HOST_RELAY : WHERE_HOST, FROM_MY_BRANCH, CHECKS_HOST] : [WHERE, FROM_MY_BRANCH, CHECKS] : [],
    ].join(' ') },
    { name: READ_DELEGATION_TOOL, inputSchema: schema(readDelegationInputSchema), description:
      `Read one of this thread's delegations: its outcome (working, background, answered, failed, stopped, paused, unknown, or refused when Sotto turned it down as it was asked for) and, once answered, the delegated thread's reply, labelled as its own words. With no delegation, list this thread's delegations, the ready models it can delegate to, ${roles ? 'what each kind of work starts on now, ' : ''}and the limits.${swarms ? ' Each role includes its usual and up-to worker counts; limits includes this machine’s ceiling and waiting starts. Swarm results carry all angle receipts plus the lead and its synthesis.' : ''} Reading charges nothing.`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: CANCEL_DELEGATION_TOOL, inputSchema: schema(cancelDelegationInputSchema), description:
      'Cancel one of this thread\'s delegations: a brief still waiting is dropped, and a delegated thread working on it is stopped, with any thread it delegated to. Nothing is deleted.' },
    ...machines ? [{ name: LIST_MACHINES_TOOL, inputSchema: schema(LIST_MACHINES_INPUT), description: place === 'this-machine' && relay
      ? 'List this machine, the one this thread runs on, and, while This computer is connected to it, the machines This computer lists: each one\'s operating system, architecture, memory and CPUs, and how many threads it is running. Facts a machine does not report read unknown. Reading charges nothing.'
      : place === 'this-machine'
      ? 'List this machine, the one this thread runs on: its operating system, architecture, memory and CPUs, and how many threads it is running. A thread here delegates only on this machine for now, so no other machine is listed. Facts this machine does not report read unknown. Reading charges nothing.'
      : 'List This computer and each connected machine: its operating system, architecture, memory and CPUs, and how many threads it is running, and newWorkersStart, where new workers start. A machine that does not report these reads unknown; one not connected says so. Reading charges nothing.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] : [],
  ]
}
export const DELEGATION_TOOL_DEFINITIONS: readonly ThreadToolDefinition[] = delegationToolDefinitions(false)
// Grok asks before a call it cannot tie to a server, and a call by the bare name is one (#800): the full names are given.
const instructions = (place: DelegationPlace): string => `These tools let this thread hand work to threads it starts on ${place === 'this-machine' ? 'this machine' : 'this computer'} (ADR-0081), such as a review on another provider. Sotto starts the thread, sends your brief and tells you its outcome. A delegated thread is the user's: it asks the user, never you, and nothing you send approves anything. When ${DELEGATE_TOOL} returns working, end your turn or carry on; Sotto sends this thread a wake-up when the outcome changes, which carries the reply once answered, labelled as the delegated thread's words. The user is not shown that wake-up, so tell them what you learned. ${READ_DELEGATION_TOOL} reads a delegation again. Where tools are found by search and called through use_tool, call them by their full names, such as ${DELEGATE_MCP_SERVER}__${DELEGATE_TOOL}.`

/**
 * `sotto_delegate`: the loopback MCP server through which an ordinary thread on this computer, or on a headless host that
 * runs delegation for its own threads (#1310), delegates work to threads it starts (ADR-0081). A thread is offered it only while delegation is on and the thread may delegate, asked at every
 * launch and every call; a second-level delegated thread, Watcher, host setup and provider jobs are offered none.
 */
export class DelegationToolServer implements ScopedThreadTools {
  readonly name = DELEGATE_MCP_SERVER
  readonly definitions: readonly ThreadToolDefinition[]
  /** Above the longest wait, so the call returns working before Codex's and Claude Code's clients give up on it (decision 8). */
  readonly timeoutMs = (DELEGATION_WAIT_MAX_SECONDS + 30) * 1000
  private readonly server: ThreadToolServer
  constructor(private readonly service: DelegationService, options: { roles?: boolean; machines?: boolean; place?: DelegationPlace; relay?: boolean; swarms?: boolean } = {}) {
    const roles = options.roles === true, machines = options.machines === true, place = options.place ?? 'this-computer'
    this.definitions = roles || machines || place !== 'this-computer' || options.swarms ? delegationToolDefinitions(roles, machines, place, options.relay === true, options.swarms === true) : DELEGATION_TOOL_DEFINITIONS
    this.server = new ThreadToolServer({ name: DELEGATE_MCP_SERVER, serverName: 'sotto-delegate', instructions: instructions(place),
      unavailable: 'Sotto\'s delegation tools are unavailable. Nothing was started.', failed: 'Sotto could not complete this delegation call. Call read_delegation to see where it stands before trying again.',
      maxRequestBytes: 256 * 1024 },
    this.definitions, (threadId, name, args, context) => this.invoke(threadId, name, args, context))
  }
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    if (!this.service.admits(threadId)) return undefined
    return this.server.mcpServer(threadId)
  }
  call(threadId: string, name: string, args: unknown, context: ThreadToolCallContext = {}): Promise<ThreadToolResult> { return this.server.call(threadId, name, args, context) }
  revoke(threadId: string): void { this.server.revoke(threadId) }
  close(): Promise<void> { return this.server.close() }
  private async invoke(threadId: string, name: string, args: unknown, context: ThreadToolCallContext): Promise<ThreadToolResult> {
    // A delegate call goes to admission even from a thread that may not delegate, so its refusal is recorded with its rule.
    const result = name === DELEGATE_TOOL ? await this.service.delegate(threadId, args, context)
      : !this.service.admits(threadId) ? { status: 'refused', code: 'NOT_ADMITTED', message: NOT_ADMITTED }
        : name === READ_DELEGATION_TOOL ? await this.service.read(threadId, args)
          : name === LIST_MACHINES_TOOL && this.definitions.some(tool => tool.name === LIST_MACHINES_TOOL) ? await this.service.machines(threadId) : await this.service.cancel(threadId, args)
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown>,
      ...((result as { status: string }).status === 'refused' ? { isError: true } : {}) }
  }
}
