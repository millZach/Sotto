import { z } from 'zod'
import { handoverCountsSchema } from '../../../shared/agents'
import { watcherIdentitySchema, type WatcherRefusal, type WatcherThreadTarget } from '../../../shared/watcher'
import { checkQueuesViewSchema, type CheckQueuesBridge } from '../../../shared/checkQueue'
import type { HostsBridge, HostsState, HostStatus } from '../../../shared/hosts'
import { threadMoveCardSchema, threadMoveProposalSchema, threadMovePrepareSchema, type ThreadMoveCard, type ThreadMovesBridge, type ThreadMovesView } from '../../../shared/threadMoves'
import { stopAllRunning, watcherMachinesReadSchema, watcherRoomStateSchema, type WatcherBridge, type WatcherRoomState } from '../../../shared/watcherRoom'

/** Where an end-to-end run leaves the projection the room should show, before it reloads the window. */
export const WATCHER_STAND_IN_KEY = 'sotto.e2e.watcherRoom'

export const watcherStandInSeedSchema = z.object({
  state: watcherRoomStateSchema,
  /** The identity `open` reports as created; without one, `open` refuses. */
  created: watcherIdentitySchema.optional(),
  /** Whether the provider confirms a permission change at once; without, the current Watcher stays on its mode. */
  permissionConfirms: z.boolean().optional(),
  /** Watch and Stop watching refuse with this, as main does for a thread it cannot watch. */
  watchRefusal: z.string().optional(),
  /**
   * What Stop all answers for each thread it stops, by thread ID; a thread not named here stops. Without it, Stop all
   * refuses, as it did before the room offered it.
   */
  stopResults: z.record(z.string(), z.object({ status: z.enum(['stopped', 'requested', 'refused', 'uncertain']), message: z.string() }).strict()).optional(),
  /** How long Stop all's stop takes to answer, so a run can act while it is still going. */
  stopDelayMs: z.number().int().min(0).max(60_000).optional(),
  /**
   * What New Watcher starts: the new Watcher's identity, and the handover of the current one it offers, with its words
   * for Read it. The current Watcher goes to history, as main does. Without it, New Watcher refuses.
   */
  startNew: z.object({ created: watcherIdentitySchema, counts: handoverCountsSchema, text: z.string() }).strict().optional(),
  /** New Watcher refuses with this, as main does while Watcher's deliveries are still pending. */
  startNewRefusal: z.string().optional(),
  /** What main reads for the machines line and Settings (#1032); without it, the bridge offers no machines read. */
  machines: watcherMachinesReadSchema.optional(),
  /** Every machine's check queue (#1312), as main sends it; without it, the window reads main's own. */
  checks: checkQueuesViewSchema.optional(),
  /**
   * Moving threads (#1178 part 2): the paired machines and whether each is connected, what Move threads' preview answers,
   * the cards main holds, and the cards it holds once the sheet's move is pressed. Without it, the window reads main's own.
   */
  moves: z.object({ machines: z.array(z.object({ hostId: z.uuid(), name: z.string().min(1), connected: z.boolean() }).strict()).max(8),
    preview: threadMovePrepareSchema.optional(), cards: z.array(threadMoveCardSchema).max(50), started: z.array(threadMoveCardSchema).max(50).optional(),
    /** This computer's host ID, which the sheet offers among the machines (part 3), and Watcher's proposals from the user's words. */
    localHostId: z.uuid().optional(), proposals: z.array(threadMoveProposalSchema).max(10).optional() }).strict().optional(),
  /**
   * Later projections, each published this long after the window first listens, so a run can watch the picture move:
   * a send delivered, a reply, a question for the user. Each replaces the parts of the projection it names.
   */
  script: z.array(z.object({ afterMs: z.number().int().min(0).max(120_000), state: watcherRoomStateSchema.partial() }).strict()).max(20).optional(),
}).strict()
export type WatcherStandInSeed = z.infer<typeof watcherStandInSeedSchema>

const NOT_HERE: WatcherRefusal = { status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE', message: 'This test run does not stop threads.', retryable: false }
const same = (a: WatcherThreadTarget, b: WatcherThreadTarget): boolean => a.hostId === b.hostId && a.threadId === b.threadId

/** Every machine's check queue, stood in for by an end-to-end run that seeds one (#1312); without a seed, none. */
export function createE2ECheckQueuesBridge(): CheckQueuesBridge | undefined {
  let raw: string | null
  try { raw = localStorage.getItem(WATCHER_STAND_IN_KEY) } catch { return undefined }
  if (raw === null) return undefined
  const checks = watcherStandInSeedSchema.parse(JSON.parse(raw)).checks
  return checks === undefined ? undefined : { read: async () => checks, onChanged: () => () => undefined }
}

/**
 * Moving threads, stood in for by an end-to-end run that seeds them (#1178 part 2): the paired machines the window reads
 * through the hosts bridge, and the moves bridge, whose start answers the seeded cards and whose press on a card that
 * asks first moves it on or keeps it here. Without a seed, none.
 */
export function createE2EThreadMovesStandIn(): { readonly moves: ThreadMovesBridge; readonly hosts: HostsBridge } | undefined {
  let raw: string | null
  try { raw = localStorage.getItem(WATCHER_STAND_IN_KEY) } catch { return undefined }
  if (raw === null) return undefined
  const seeded = watcherStandInSeedSchema.parse(JSON.parse(raw)).moves
  if (seeded === undefined) return undefined
  let view: ThreadMovesView = { cards: seeded.cards, ...seeded.proposals ? { proposals: seeded.proposals } : {} }
  const listeners = new Set<(next: ThreadMovesView) => void>()
  const publish = (cards: readonly ThreadMoveCard[], proposals = view.proposals): void => {
    view = { cards: [...cards], ...proposals ? { proposals: [...proposals] } : {} }
    for (const listener of [...listeners]) listener(view)
  }
  const hostsState = { localHostEnabled: true, localHostRunning: true, ...seeded.localHostId ? { localHostId: seeded.localHostId } : {}, hosts: seeded.machines.map(machine => ({ id: machine.hostId, hostId: machine.hostId, name: machine.name,
    target: machine.name, identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: machine.connected ? 'connected' : 'disconnected', enabled: true }) as HostStatus) } as HostsState
  const moves: ThreadMovesBridge = {
    prepare: async () => seeded.preview ?? { status: 'refused', message: 'This test run moves no threads.' },
    start: async () => { publish([...view.cards, ...seeded.started ?? []]); return { status: 'ok', moves: [] } },
    read: async () => view,
    answer: async request => {
      const at = new Date().toISOString()
      if ('proposalId' in request) {
        // Watcher's proposal: Move moves the threads ticked and shows the seeded cards; Not now ends it.
        const proposals = (view.proposals ?? []).map(proposal => proposal.id !== request.proposalId ? proposal : request.answer === 'dismiss' ? { ...proposal, state: 'dismissed' as const, updatedAt: at }
          : { ...proposal, state: 'moved' as const, threads: proposal.threads.map(item => ({ ...item, ticked: request.threadIds.includes(item.threadId) })), updatedAt: at })
        publish(request.answer === 'move' ? [...view.cards, ...seeded.started ?? []] : view.cards, proposals)
        return { status: 'ok' }
      }
      if ('moveId' in request) {
        // Keep it here: the press is kept, and the move waits for its machine to call it off.
        publish(view.cards.map(card => card.id === request.moveId ? threadMoveCardSchema.parse({ ...card, keeping: true, updatedAt: at }) : card))
        return { status: 'ok' }
      }
      const { cardId, answer } = request
      publish(view.cards.map(card => card.id !== cardId ? card : answer === 'keep' ? { ...card, state: 'kept', updatedAt: at }
        : { ...card, state: 'fenced', updatedAt: at, words: undefined, startsOn: undefined }).map(card => threadMoveCardSchema.parse(JSON.parse(JSON.stringify(card)))))
      return { status: 'ok' }
    },
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const hosts = { get: async () => hostsState, onChanged: () => () => undefined } as unknown as HostsBridge
  return { moves, hosts }
}

/**
 * Main's Watcher bridge, stood in for by an end-to-end run that seeds one, so the room's renderer is checked on a
 * fixed projection whatever main's side does. `open` takes the seeded identity as the one main created. Permissions,
 * Watch and Stop watching answer
 * as the contract says main does: the remembered mode and the current Watcher's, and a standing watch with the row
 * marked watched, kept until Stop watching. Without a seed there is no stand-in.
 */
export function createE2EWatcherBridge(): WatcherBridge | undefined {
  let raw: string | null
  try { raw = localStorage.getItem(WATCHER_STAND_IN_KEY) } catch { return undefined }
  if (raw === null) return undefined
  const seed = watcherStandInSeedSchema.parse(JSON.parse(raw))
  let state: WatcherRoomState = seed.state
  const listeners = new Set<(next: WatcherRoomState) => void>()
  let scripted = false
  const publish = (patch: Partial<WatcherRoomState>): WatcherRoomState => {
    state = { ...state, ...patch, observedAt: new Date().toISOString() }
    for (const listener of [...listeners]) listener(state)
    return state
  }
  return {
    get: async () => ({ status: 'ok', state }),
    open: async request => {
      if (seed.created === undefined) return { ...NOT_HERE, message: 'This test run starts no Watcher.' }
      return { status: 'ok', state: publish({ current: { ...seed.created, provider: request.provider },
        currentOptions: { modelId: request.modelId, reasoningEffort: request.reasoningEffort ?? null, status: 'idle', connected: true } }) }
    },
    setPermission: async ({ runtimeMode }) => {
      const confirms = seed.permissionConfirms !== false
      return { status: 'ok', state: publish({ runtimeMode,
        currentOptions: state.currentOptions === null || !confirms ? state.currentOptions : { ...state.currentOptions, runtimeMode } }) }
    },
    watchThread: async ({ target }) => {
      if (seed.watchRefusal !== undefined) return { ...NOT_HERE, code: 'HOST_DISCONNECTED', message: seed.watchRefusal, retryable: true }
      const watches = state.standingWatches ?? []
      const known = state.watchedThreads.some(row => same(row.target, target))
      return { status: 'ok', state: publish({
        standingWatches: watches.some(watch => same(watch.target, target)) ? watches
          : [...watches, { id: crypto.randomUUID(), target, createdAt: new Date().toISOString(), generation: 0 }],
        watchedThreads: known ? state.watchedThreads.map(row => same(row.target, target) ? { ...row, watched: true, paused: false } : row)
          : [...state.watchedThreads, { target, title: target.threadId, watched: true, paused: false, status: 'idle', connected: true, settled: false,
            backgroundWorkCount: 0, waitsOn: [], participation: [] }],
      }) }
    },
    unwatchThread: async ({ target }) => {
      if (seed.watchRefusal !== undefined) return { ...NOT_HERE, code: 'HOST_DISCONNECTED', message: seed.watchRefusal, retryable: true }
      return { status: 'ok', state: publish({
        standingWatches: (state.standingWatches ?? []).filter(watch => !same(watch.target, target)),
        watchedThreads: state.watchedThreads.map(row => same(row.target, target) ? { ...row, watched: false, paused: false } : row),
      }) }
    },
    // Stop all as main answers it: a preview of the running threads Watcher started, then each one's result, and the
    // threads that stopped no longer running.
    prepareStopAll: async () => seed.stopResults === undefined ? NOT_HERE : ({ status: 'ok', confirmationId: crypto.randomUUID(),
      targets: stopAllRunning(state), expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    stopAll: async () => {
      if (seed.stopResults === undefined) return NOT_HERE
      if (seed.stopDelayMs) await new Promise(resolve => setTimeout(resolve, seed.stopDelayMs))
      const results = stopAllRunning(state).map(target => ({ target, ...seed.stopResults?.[target.threadId] ?? { status: 'stopped' as const, message: 'Stopped.' } }))
      const stopped = results.filter(result => result.status === 'stopped').map(result => result.target)
      return { status: 'ok', results, state: publish({ watchedThreads: state.watchedThreads.map(row => stopped.some(item => same(item, row.target))
        ? { ...row, status: 'idle', backgroundWorkCount: 0 } : row) }) }
    },
    // New Watcher as main answers it: the current Watcher to history and the seeded one current, on the same choices,
    // with the last one's handover offered until it is put away.
    startNew: async () => {
      if (seed.startNewRefusal !== undefined) return { ...NOT_HERE, code: 'THREAD_BUSY', message: seed.startNewRefusal, retryable: true }
      const last = state.current
      if (seed.startNew === undefined || last === null) return { ...NOT_HERE, message: 'This test run starts no new Watcher.' }
      const created = { ...seed.startNew.created, provider: last.provider }
      return { status: 'ok', state: publish({ current: created, history: [...state.history, last],
        handover: { source: last.target, provider: last.provider, counts: seed.startNew.counts } }) }
    },
    readHandover: async () => state.handover == null || seed.startNew === undefined ? { ...NOT_HERE, code: 'TARGET_CHANGED', message: 'There is no handover to read.' }
      : { status: 'ok', text: seed.startNew.text, counts: state.handover.counts },
    continueWithHandover: async () => ({ status: 'ok', state }),
    dismissHandover: async () => ({ status: 'ok', state: publish({ handover: null }) }),
    ...seed.machines ? { readMachines: async () => seed.machines! } : {},
    onChanged: listener => {
      // The script starts with the first listener, the room's own.
      if (listeners.size === 0 && !scripted) {
        scripted = true
        for (const step of seed.script ?? []) setTimeout(() => publish(step.state as Partial<WatcherRoomState>), step.afterMs)
      }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
