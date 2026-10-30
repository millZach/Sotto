import { join } from 'node:path'
import { z } from 'zod'
import type { AgentRuntimeMode, AgentThread } from '../../shared/agents'
import { agentRuntimeModeSchema } from '../../shared/agents'
import { readDesktopDefaults, type DesktopDefaults, type DesktopDefaultsInput, type DesktopDefaultsReceipt, type HostCeilingHold } from '../../shared/desktopDefaults'
import { parseWorkerRoleChoices, type WorkerRoleChoices } from '../../shared/workerRoles'
import { DEFAULT_WORKER_CEILING, workerCeilingSchema, WORKER_SYSTEM_WORDS } from '../../shared/workerMachine'
import type { WatcherRefusal } from '../../shared/watcher'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { hostMachineReport, type HostFactsSource } from './hostFacts'
import type { DelegationServiceOptions } from './delegation'
import type { HostDelegationRelay } from './delegationRelayHost'
import type { PlacementAsk, WorkerPlacement } from './workerPlacement'

const keptSchema = z.object({
  /** The paired desktop that sent them, which must still be paired with a `remote-answer` grant on this host to count. */
  clientId: z.string().min(1).max(512),
  newThreadRuntimeMode: agentRuntimeModeSchema.nullable(),
  workerRoles: z.unknown().optional(),
  workerCeiling: workerCeilingSchema.optional().catch(undefined),
  /** When they came, by this host's clock: returned in the receipt and never used to order them, as a clock can move back. */
  receivedAt: z.iso.datetime(),
  /** The order they came in: one more than the newest kept when they were received. The last sent is the highest. */
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
const fileSchema = z.object({ version: z.literal(1), desktops: z.array(keptSchema).max(512) }).strict()
type DesktopDefaultsFile = z.infer<typeof fileSchema>
interface Kept extends DesktopDefaults { readonly clientId: string; readonly receivedAt: string; readonly sequence: number }
/** How many desktops' defaults a host keeps; the oldest beyond it are dropped. A forgotten desktop's stop counting anyway. */
export const KEPT_DESKTOP_DEFAULTS = 16
/** Whether a desktop's defaults count on this host now: it is still paired here and may answer permission requests here. */
export type DesktopCounts = (clientId: string) => boolean

/**
 * The desktop defaults a headless host keeps (#1310): the new-thread default and worker roles each desktop last sent, with
 * its client ID, when they came and the order they came in, in `desktop-defaults.json` beside the host's other records. Settings, not a key:
 * nothing here is secret and nothing here grants anything. Kept across restarts, so a host a desktop has told keeps to
 * them while the desktop is away.
 *
 * With several desktops, the last one sent applies, among the desktops that still count (Zach, October 23): still paired
 * here, with an answers grant, read afresh at every start. A desktop that is forgotten, revoked or loses its grant stops
 * counting at once and after a restart alike, and the most recent defaults from a desktop that still counts apply instead
 * (ADR-0074 decision 3: a wider start needs a desktop that may answer there). When none counts, every start is held to
 * Ask for approval with the roles' own defaults; a host never told says so.
 * Capacity is separate: a paired, recorded desktop's worker ceiling applies even without an answers grant.
 */
export class DesktopDefaultsStore {
  private readonly store: AtomicJsonStore<DesktopDefaultsFile>
  /** Newest first, one per desktop. */
  private kept: readonly Kept[] = []
  /**
   * Every load and record in the order they were called, one at a time, so each record builds on what the one before it
   * saved. Two desktops sending at once must not each start from the same old list: the one saved last would bring back
   * defaults the other had just replaced, and those would apply again once the last desktop stopped counting.
   */
  private queue: Promise<unknown> = Promise.resolve()
  constructor(directory: string, private readonly now: () => Date = () => new Date()) {
    this.store = new AtomicJsonStore(join(directory, 'desktop-defaults.json'), input => fileSchema.parse(input), (): DesktopDefaultsFile => ({ version: 1, desktops: [] }))
  }
  /** Reads what was kept. A record that does not read is treated as never told, which can only narrow a start. */
  async load(): Promise<void> {
    return this.serialized(async () => {
      const file = await this.store.read().catch((): DesktopDefaultsFile => ({ version: 1, desktops: [] }))
      // Newest first by the order they came in, never by the clock, so the last sent stays the last after a restart.
      this.kept = file.desktops.map(saved => ({ clientId: saved.clientId, receivedAt: saved.receivedAt, sequence: saved.sequence, newThreadRuntimeMode: saved.newThreadRuntimeMode,
        ...(saved.workerRoles !== undefined ? { workerRoles: parseWorkerRoleChoices(saved.workerRoles) } : {}),
        ...(saved.workerCeiling !== undefined ? { workerCeiling: saved.workerCeiling } : {}) }))
        .sort((a, b) => b.sequence - a.sequence).slice(0, KEPT_DESKTOP_DEFAULTS)
    })
  }
  /**
   * Keeps a desktop's defaults in place of the ones it sent before, saved before it answers. A save that fails keeps the old
   * ones. Runs after every earlier record has saved or failed, and reads the list only then.
   */
  async record(clientId: string, input: DesktopDefaultsInput): Promise<DesktopDefaultsReceipt> {
    const defaults = readDesktopDefaults(input)
    return this.serialized(async () => {
      // The newest kept is first and is never dropped, so the next number is always above every number on record.
      const receivedAt = this.now().toISOString(), sequence = (this.kept[0]?.sequence ?? 0) + 1
      const priorCeiling = this.kept.find(item => item.clientId === clientId)?.workerCeiling
      const next = [{ clientId, receivedAt, sequence,
        // A stable desktop sends no swarm fields; it must not erase the saved choice for the next Owl connection.
        ...priorCeiling === undefined ? {} : { workerCeiling: priorCeiling }, ...defaults },
      ...this.kept.filter(item => item.clientId !== clientId)].slice(0, KEPT_DESKTOP_DEFAULTS)
      await this.store.write({ version: 1, desktops: next.map(item => ({ clientId: item.clientId, newThreadRuntimeMode: item.newThreadRuntimeMode,
        ...(item.workerRoles ? { workerRoles: item.workerRoles } : {}), ...(item.workerCeiling === undefined ? {} : { workerCeiling: item.workerCeiling }),
        receivedAt: item.receivedAt, sequence: item.sequence })) })
      this.kept = next
      return { receivedAt }
    })
  }
  /** Runs `work` once everything queued before it has finished, whether that succeeded or not. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }
  /** The defaults that apply now: the most recent from a desktop that still counts, or none. */
  current(counts: DesktopCounts): Kept | undefined { return this.kept.find(item => counts(item.clientId)) }
  /**
   * The widest a thread delegated on this host may start on, as the desktop's new-thread default: the defaults that apply
   * now, asked afresh each time so a desktop forgotten or a grant taken away holds the next start at once. Ask for approval
   * when none apply, and `held` says why: no desktop has told this host, or none that told it still counts.
   */
  ceiling(counts: DesktopCounts, revoked: DesktopCounts = () => false): { readonly mode: AgentRuntimeMode; readonly held?: HostCeilingHold } {
    if (!this.kept.length) return { mode: 'approval-required', held: 'not-told' }
    const applies = this.current(counts)
    if (applies) return { mode: applies.newThreadRuntimeMode ?? 'approval-required' }
    // Said as revoked when the desktop that sent the newest defaults had its answers grant taken away (#1310), so the window
    // offers no fix that cannot work: setting it up again never grants what was revoked.
    return { mode: 'approval-required', held: revoked(this.kept[0]!.clientId) ? 'answers-revoked' : 'no-answer-grant' }
  }
  /** The worker roles of the defaults that apply now, or the roles' own defaults when they carry none or none apply. */
  roles(counts: DesktopCounts): WorkerRoleChoices { return this.current(counts)?.workerRoles ?? {} }
  /** Capacity eligibility needs a paired, recorded desktop; this limit grants no permission. */
  workerCeiling(counts: DesktopCounts): number { return this.current(counts)?.workerCeiling ?? DEFAULT_WORKER_CEILING }
}


/** The name a delegated thread's placement gives the machine it started on, from that machine's own side. */
export const THIS_MACHINE = 'This machine'
const ONLY_HERE = 'A thread on this machine delegates only to threads on this machine for now.'
const LEAVE_OUT = 'Leave out the machine and system to start it here. Nothing was started.'
/** With the desktop relay (#1316): what a thread here may reach, and how its list says so. */
const HERE_OR_RELAYED = 'A thread on this machine delegates to threads on this machine, or through This computer to threads on This computer.'
const refusal = (message: string): WatcherRefusal => ({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE', message, retryable: false })
/** `place`'s host ID for a start the desktop relays (#1316): another machine, which the desktop places. */
export const RELAYED_HOST = 'relay'
/** What the machine list and placement read of the desktop relay (#1316), present only where it runs. */
export type HostRelayMachines = Pick<HostDelegationRelay, 'reachable' | 'awayWords' | 'machines'>

/**
 * Where a thread on a headless host may delegate (#1310): this machine, and, with the desktop relay (#1316), other machines
 * through the desktop while one that relays is connected. `list_machines` lists this machine with its facts, and the
 * desktop's own list beside it while it relays; a call that names this machine, or its own system, starts here. Another
 * machine or system goes to the desktop, which places it; while no desktop that relays is connected it is refused by name
 * and recorded, and nothing is queued. Without the relay, another machine or system is refused in plain words and
 * recorded, as before.
 */
export function hostDelegationMachines(hostId: () => string | undefined, facts: HostFactsSource, threads: () => readonly Pick<AgentThread, 'id' | 'status'>[],
  relay?: HostRelayMachines, swarm?: () => { readonly workerCeiling: number; readonly workerQueued: number }): NonNullable<DelegationServiceOptions['machines']> {
  const here = (id: string) => ({ hostId: id, projectId: '', receipt: { hostId: id, name: THIS_MACHINE, awayFromDefault: false } })
  const elsewhere = (ask: PlacementAsk, project: { readonly projectId: string }, why: string): WorkerPlacement | WatcherRefusal => {
    if (!relay) return refusal(why)
    if (!relay.reachable()) return { status: 'refused', code: 'HOST_DISCONNECTED', message: relay.awayWords(), retryable: true }
    return { hostId: ask.machine ?? RELAYED_HOST, projectId: project.projectId, receipt: { hostId: ask.machine ?? RELAYED_HOST, name: 'Another machine', awayFromDefault: false } }
  }
  return {
    list: async () => {
      const id = hostId()
      let report: Awaited<ReturnType<typeof hostMachineReport>> | undefined
      try { report = await hostMachineReport(facts, () => ({ threads: threads() }), false) } catch { report = undefined }
      const self = { hostId: id, name: THIS_MACHINE, thisComputer: true, connected: true,
        ...swarm?.(),
        ...report ? { factsState: 'reported', facts: report.facts, runningThreads: report.runningThreads }
          : { factsState: 'unknown', facts: null, note: 'This machine\'s facts could not be read just now. Nothing was changed. Ask again.', runningThreads: null } }
      if (relay) {
        // The desktop's own list, read when asked and never on a timer; this machine is listed once, as this machine.
        const desktop = await relay.machines()
        const listed = Array.isArray(desktop?.machines) ? (desktop.machines as unknown[]).filter(machine =>
          machine !== null && typeof machine === 'object' && (machine as { hostId?: unknown }).hostId !== id).map(machine => ({ ...(machine as Record<string, unknown>), thisComputer: false })) : []
        return { status: 'ok', machines: [self, ...listed],
          note: desktop ? `${HERE_OR_RELAYED} Machines are listed as This computer lists them.` : `${relay.awayWords()} Only this machine is listed.`, observedAt: new Date().toISOString() }
      }
      return { status: 'ok', machines: [self], note: `${ONLY_HERE} Other machines cannot be reached from here yet.`, observedAt: new Date().toISOString() }
    },
    place: async (ask, project) => {
      const id = hostId() ?? project.hostId
      if (ask.machine !== undefined && ask.machine !== id) return elsewhere(ask, project, `${ONLY_HERE} It cannot start on another machine. ${LEAVE_OUT}`)
      if (ask.os !== undefined) {
        let family: string | null
        try { family = (await facts.read()).os.family } catch { family = null }
        const wanted = WORKER_SYSTEM_WORDS[ask.os]
        // A machine named as this one keeps its own system's refusal; with none named, the desktop finds one of that system.
        if (family !== ask.os && ask.machine === undefined && relay) return elsewhere(ask, project, '')
        if (family === null) return refusal(`This machine does not say which system it runs, so Sotto cannot tell whether it is ${wanted.a}. ${LEAVE_OUT}`)
        if (family !== ask.os) return refusal(`${ONLY_HERE} This machine is not ${wanted.a}, and a system never falls back to another. ${LEAVE_OUT}`)
      }
      return here(id)
    },
    name: () => THIS_MACHINE,
    setting: () => 'this-computer',
  }
}
