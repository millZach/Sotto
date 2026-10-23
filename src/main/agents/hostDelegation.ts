import { join } from 'node:path'
import { z } from 'zod'
import type { AgentRuntimeMode, AgentThread } from '../../shared/agents'
import { agentRuntimeModeSchema } from '../../shared/agents'
import { readDesktopDefaults, type DesktopDefaults, type DesktopDefaultsInput, type DesktopDefaultsReceipt, type HostCeilingHold } from '../../shared/desktopDefaults'
import { parseWorkerRoleChoices, type WorkerRoleChoices } from '../../shared/workerRoles'
import { WORKER_SYSTEM_WORDS } from '../../shared/workerMachine'
import type { WatcherRefusal } from '../../shared/watcher'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { hostMachineReport, type HostFactsSource } from './hostFacts'
import type { DelegationServiceOptions } from './delegation'

const fileSchema = z.object({
  version: z.literal(1),
  defaults: z.object({
    /** The paired desktop that sent them, whose `remote-answer` grant on this host decides whether they may be used as sent. */
    clientId: z.string().min(1).max(512),
    newThreadRuntimeMode: agentRuntimeModeSchema.nullable(),
    workerRoles: z.unknown().optional(),
    receivedAt: z.iso.datetime(),
  }).strict().nullable(),
}).strict()
type DesktopDefaultsFile = z.infer<typeof fileSchema>
interface Kept extends DesktopDefaults { readonly clientId: string; readonly receivedAt: string }

/**
 * The desktop defaults a headless host keeps (#1310): the new-thread default and worker roles the last desktop to send
 * them gave, with that desktop's client ID and when they came, in `desktop-defaults.json` beside the host's other records.
 * Settings, not a key: nothing here is secret and nothing here grants anything. Kept across restarts, so a host the desktop
 * has told once keeps to them while the desktop is away. A host never told answers none, and delegation holds every start
 * to Ask for approval.
 */
export class DesktopDefaultsStore {
  private readonly store: AtomicJsonStore<DesktopDefaultsFile>
  private kept: Kept | undefined
  constructor(directory: string, private readonly now: () => Date = () => new Date()) {
    this.store = new AtomicJsonStore(join(directory, 'desktop-defaults.json'), input => fileSchema.parse(input), (): DesktopDefaultsFile => ({ version: 1, defaults: null }))
  }
  /** Reads what was kept. A record that does not read is treated as never told, which can only narrow a start. */
  async load(): Promise<void> {
    const file = await this.store.read().catch((): DesktopDefaultsFile => ({ version: 1, defaults: null }))
    const saved = file.defaults
    this.kept = saved ? { clientId: saved.clientId, receivedAt: saved.receivedAt, newThreadRuntimeMode: saved.newThreadRuntimeMode,
      ...(saved.workerRoles !== undefined ? { workerRoles: parseWorkerRoleChoices(saved.workerRoles) } : {}) } : undefined
  }
  /** Keeps a desktop's defaults in place of whatever was kept, saved before it answers. A save that fails keeps the old ones. */
  async record(clientId: string, input: DesktopDefaultsInput): Promise<DesktopDefaultsReceipt> {
    const defaults = readDesktopDefaults(input), receivedAt = this.now().toISOString()
    const next: Kept = { clientId, receivedAt, ...defaults }
    await this.store.write({ version: 1, defaults: { clientId, newThreadRuntimeMode: next.newThreadRuntimeMode,
      ...(next.workerRoles ? { workerRoles: next.workerRoles } : {}), receivedAt } })
    this.kept = next
    return { receivedAt }
  }
  current(): Kept | undefined { return this.kept }
  /**
   * The widest a thread delegated on this host may start on, as the desktop's new-thread default: Ask for approval when no
   * desktop has told this host, and no wider than Ask for approval unless the desktop that told it may answer here,
   * asked afresh each time so a grant taken away holds the next start at once. `held` says why when that narrowed it.
   */
  ceiling(mayAnswer: (clientId: string) => boolean): { readonly mode: AgentRuntimeMode; readonly held?: HostCeilingHold } {
    const kept = this.kept
    if (!kept) return { mode: 'approval-required', held: 'not-told' }
    const told = kept.newThreadRuntimeMode ?? 'approval-required'
    if (told === 'approval-required' || mayAnswer(kept.clientId)) return { mode: told }
    return { mode: 'approval-required', held: 'no-answer-grant' }
  }
  /** The worker roles the desktop sent, or the roles' own defaults when it sent none. */
  roles(): WorkerRoleChoices { return this.kept?.workerRoles ?? {} }
}


/** The name a delegated thread's placement gives the machine it started on, from that machine's own side. */
export const THIS_MACHINE = 'This machine'
const ONLY_HERE = 'A thread on this machine delegates only to threads on this machine for now.'
const LEAVE_OUT = 'Leave out the machine and system to start it here. Nothing was started.'
const refusal = (message: string): WatcherRefusal => ({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE', message, retryable: false })

/**
 * Where a thread on a headless host may delegate (#1310): this machine and nowhere else until #1316 carries delegations
 * between machines. `list_machines` lists this machine alone with its facts; a call that names this machine, or its own
 * system, starts here; another machine or system is refused in plain words and recorded, as the desktop refuses one.
 */
export function hostDelegationMachines(hostId: () => string | undefined, facts: HostFactsSource, threads: () => readonly Pick<AgentThread, 'status'>[]): NonNullable<DelegationServiceOptions['machines']> {
  const here = (id: string) => ({ hostId: id, projectId: '', receipt: { hostId: id, name: THIS_MACHINE, awayFromDefault: false } })
  return {
    list: async () => {
      const id = hostId()
      let report: Awaited<ReturnType<typeof hostMachineReport>> | undefined
      try { report = await hostMachineReport(facts, threads()) } catch { report = undefined }
      return { status: 'ok', machines: [{ hostId: id, name: THIS_MACHINE, thisComputer: true, connected: true,
        ...report ? { factsState: 'reported', facts: report.facts, runningThreads: report.runningThreads }
          : { factsState: 'unknown', facts: null, note: 'This machine\'s facts could not be read just now. Nothing was changed. Ask again.', runningThreads: null } }],
      note: `${ONLY_HERE} Other machines cannot be reached from here yet.`, observedAt: new Date().toISOString() }
    },
    place: async (ask, project) => {
      const id = hostId() ?? project.hostId
      if (ask.machine !== undefined && ask.machine !== id) return refusal(`${ONLY_HERE} It cannot start on another machine. ${LEAVE_OUT}`)
      if (ask.os !== undefined) {
        let family: string | null
        try { family = (await facts.read()).os.family } catch { family = null }
        const wanted = WORKER_SYSTEM_WORDS[ask.os]
        if (family === null) return refusal(`This machine does not say which system it runs, so Sotto cannot tell whether it is ${wanted.a}. ${LEAVE_OUT}`)
        if (family !== ask.os) return refusal(`${ONLY_HERE} This machine is not ${wanted.a}, and a system never falls back to another. ${LEAVE_OUT}`)
      }
      return here(id)
    },
    name: () => THIS_MACHINE,
    setting: () => 'this-computer',
  }
}
