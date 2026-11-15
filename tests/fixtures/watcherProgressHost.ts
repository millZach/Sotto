// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { WatcherService } from '../../src/main/agents/watcher'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { WatcherEvidence, WatcherOperation, WatcherRequest, WatcherThreadTarget } from '../../src/shared/watcher'
import type { WatcherHostProjection } from '../../src/shared/watcherHost'
import { rawPeer } from './rawHostPeer'

/**
 * A host whose Watcher projection for one paired desktop the test sets, over the real socket server, the host service a
 * headless host runs and the desktop's real client (ADR-0073, November 10, 2026 amendment). Its Watcher is a stand-in that
 * hands out the projection the way `WatcherService.remoteProjection` does: the requests, operations and standing watches
 * of one record are the same lists until the record changes, the evidence is a new list on every read, and the revision is
 * a digest of the record's part, the evidence and the progress. Each change it makes is published, as a Watcher change
 * is, so the socket server pushes it to every desktop that read the projection. Everything in it is synthetic.
 *
 * It uses nothing the host's code from before `watcher-progress` lacks, so the benchmark built on it measures the code
 * before the change the same way it measures the code after.
 */
export const PROGRESS_HOST_ID = '11111111-1111-4111-8111-111111111111'
const AT = '2026-11-10T12:00:00.000Z'
const DESKTOP_HOST_ID = '22222222-2222-4222-8222-222222222222'
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fingerprint = (seed: string): string => digest(seed)

export interface ProgressHostSize { requests: number; operations: number; targets: number }

/** Requests and operations shaped as a host keeps them for a paired desktop's Watcher, every request closed. */
function syntheticWork(size: ProgressHostSize, master: WatcherHostProjection['master'], clientId: string, targets: readonly WatcherThreadTarget[]) {
  const requests: WatcherRequest[] = Array.from({ length: size.requests }, (_, index) => {
    const id = randomUUID()
    const taking = [targets[(index * 2) % targets.length]!, targets[(index * 2 + 1) % targets.length]!]
    return { id, watcher: master.target, rootUserMessageId: `watcher-prompt-${index}`, state: 'closed', createdAt: AT, closedAt: AT,
      remoteOrigin: { clientId, master, creationOperationId: master.creationOperationId, ceiling: 'approval-required' },
      participants: taking.map((target, position) => ({ target, requestId: id, startedBy: 'watcher' as const, generation: 0,
        state: position === 0 ? 'participating' as const : 'relinquished' as const, lastUserMessageId: null, promptCount: 1 })) }
  })
  const operations: WatcherOperation[] = Array.from({ length: size.operations }, (_, index) => syntheticOperation(requests[index % requests.length]!, index))
  return { requests, operations }
}
function syntheticOperation(request: WatcherRequest, index: number): WatcherOperation {
  return { id: randomUUID(), requestId: request.id, retryKey: randomUUID(), digest: fingerprint(`operation-${index}`), promptTurnId: randomUUID(),
    action: index % 3 === 0 ? 'start' : 'send', target: request.participants[0]!.target, generation: 0, deliveryState: 'accepted',
    createdAt: AT, updatedAt: AT, receiptId: `receipt-${index}`, cardId: `card-${index}` }
}

export async function watcherProgressHost(size: ProgressHostSize) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-watcher-progress-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const state = emptyDesktopState(PROGRESS_HOST_ID)
  const control = { get: () => state, shell: () => state, threadDetail: () => null, subscribe: () => () => undefined, commandShell: async () => state }
  const master: WatcherHostProjection['master'] = { target: { hostId: DESKTOP_HOST_ID, threadId: 'synthetic-watcher' }, projectId: 'synthetic-project',
    provider: 'codex', creationOperationId: randomUUID(), createdAt: AT }
  const clientId = randomUUID()
  let targets: WatcherThreadTarget[] = Array.from({ length: size.targets }, (_, index) => ({ hostId: PROGRESS_HOST_ID, threadId: `synthetic-worker-${index}` }))
  const work = syntheticWork(size, master, clientId, targets)
  const requests = work.requests, standingWatches: NonNullable<WatcherHostProjection['standingWatches']> = []
  let operations = work.operations
  let workRevision = digest([requests, operations, standingWatches])
  let evidence: WatcherEvidence[] = []
  let steps = 0, observedAt = AT
  let progress = targets.map(target => ({ target, fingerprint: fingerprint(`${target.threadId}-0`) }))
  const listeners = new Set<() => void>()
  const projection = (): WatcherHostProjection => {
    const shown = [...evidence]
    return { hostId: PROGRESS_HOST_ID, master, requests, operations, evidence: shown, progress, standingWatches, revision: digest([workRevision, shown, progress]), observedAt }
  }
  const watcher = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    remoteProjection: () => projection(),
    readRemote: async () => projection(),
  }
  const desktops = { refresh: async () => undefined, has: () => true }
  const server = await startSocketServer({ service: new LocalHostService({ control, watcher: watcher as unknown as WatcherService }), pairing, watcherDesktops: desktops })
  const url = `http://127.0.0.1:${server.descriptor.port}`
  const clients: SocketHostService[] = [], peers: Awaited<ReturnType<typeof rawPeer>>[] = []
  const published = (): void => { observedAt = new Date(Date.parse(AT) + ++steps * 1_000).toISOString(); for (const listener of listeners) listener() }

  return {
    master, url,
    /** The projection the host would build now. */
    projection,
    /** One watched thread takes a step: its fingerprint moves, and nothing else does. */
    step(index = steps % targets.length): void {
      const target = targets[index]!
      progress = progress.map(entry => entry.target === target ? { target, fingerprint: fingerprint(`${target.threadId}-${steps + 1}`) } : entry)
      published()
    },
    /** A thread starts being watched, above the others in the host's list, with its first fingerprint. */
    watchFirst(): void {
      const target = { hostId: PROGRESS_HOST_ID, threadId: `synthetic-worker-${targets.length}` }
      targets = [target, ...targets]
      progress = [{ target, fingerprint: fingerprint(`${target.threadId}-0`) }, ...progress]
      published()
    },
    /** The last watched thread stops being watched. */
    unwatchLast(): void { targets = targets.slice(0, -1); progress = progress.slice(0, -1); published() },
    /** The record changes: an operation is added, so the record's lists are new. */
    record(): void {
      operations = [...operations, syntheticOperation(requests[0]!, operations.length)]
      workRevision = digest([requests, operations, standingWatches])
      published()
    },
    /** New evidence about a watched thread. */
    evidence(): void {
      evidence = [...evidence, { id: `evidence-${evidence.length}`, source: 'native-turn', observedAt: AT, target: targets[0]!, freshness: 'fresh', availability: 'available', fact: 'turn-finished' }]
      published()
    },
    /** The desktop's real client, paired and connected, its Watcher on. `frames` is every message it was sent, as text. */
    async desktop() {
      const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Synthetic desktop')
      const client = new SocketHostService({ url, token: paired.token, watcherEnabled: true, catchUpEvents: false }); clients.push(client)
      const frames: string[] = []
      const internal = client as unknown as { receive(text: string): void }
      const receive = internal.receive.bind(client)
      internal.receive = (text: string) => { frames.push(text); receive(text) }
      const hello = await client.connect()
      return { client, frames, hello }
    },
    /** A paired desktop speaking the wire itself, whose hello accepts `accepts`, offering compression as a desktop does. */
    async rawDesktop(accepts: string[]) {
      const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Synthetic older desktop')
      const session = pairing.signSession(paired.clientId)
      const peer = await rawPeer(server.descriptor.port, session, { offer: 'permessage-deflate; client_no_context_takeover; server_no_context_takeover' }); peers.push(peer)
      expect(await peer.call('hello', { op: 'hello', afterSeq: Number.MAX_SAFE_INTEGER, accepts })).toMatchObject({ ok: true })
      return peer
    },
    async close(): Promise<void> {
      for (const client of clients.splice(0)) await client.close()
      for (const peer of peers.splice(0)) peer.frames.close()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
export type WatcherProgressHost = Awaited<ReturnType<typeof watcherProgressHost>>
