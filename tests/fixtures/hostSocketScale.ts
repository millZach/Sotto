import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateRawSync } from 'node:zlib'
import { SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentThread } from '../../src/shared/agents'
import type { WatcherIdentity } from '../../src/shared/watcher'
import { iphoneAccepts } from './iphoneAccepts.mjs'
import type { OwnerScale } from './ownerScale'
import { ownerScalePipeline, type OwnerScalePipeline, type OwnerScaleTrack } from './ownerScalePipeline'
import { rawPeer } from './rawHostPeer'
import { stepClock, type StepClock } from './stepClock'

/**
 * The paired desktop's own Watcher, as it names itself to the host: a Watcher on another computer, made on October 28,
 * when forge's record of the laptop's work begins.
 */
export const DESKTOP_WATCHER: WatcherIdentity = { target: { hostId: '7d3e2a10-4b5c-4d6e-8f70-1a2b3c4d5e6f', threadId: '0b1c2d3e-4f50-4a61-b728-394a5b6c7d8e' },
  projectId: 'synthetic-watcher-project', provider: 'claude', creationOperationId: '5e6f7a8b-9cad-4bef-8012-3456789abcde', createdAt: '2026-10-28T09:00:00.000Z' }

/**
 * How long, in real time, what one end of a socket wrote may take to be read at the other: the suite's test deadline
 * (`vitest.config.ts`). A push takes milliseconds; the deadline is only reached when a socket closed under its message.
 */
const DELIVERY_DEADLINE_MS = 15_000
/** The test fakes `performance` and `Date`; the deadline is on the machine's clock. */
const realNow = (): number => Number(process.hrtime.bigint()) / 1e6

/**
 * Both ends of every host socket opened from now on, so a step of the fake clock can wait until each end has read what the
 * other wrote: no message still compressing off the loop or waiting for its socket to drain (`backlogged`), and every byte
 * one end's socket was given read by the other end's. A desktop's push over 64 KiB is compressed on Node's thread pool, so
 * how soon it goes depends on the machine's load; waiting for it makes what the peers are sent the same on any machine.
 * Each end is known by its first `feed`, which the host and every client make as a socket opens.
 */
function socketDelivery(): { idle(): boolean; delivered(): Promise<void>; dispose(): void } {
  const ends = new Set<SocketFrames>()
  const prototype = SocketFrames.prototype, nativeFeed = prototype.feed
  prototype.feed = function (this: SocketFrames, data: Buffer): void { ends.add(this); nativeFeed.call(this, data) }
  const socketOf = (end: SocketFrames): Socket => (end as unknown as { stream: Socket }).stream
  /** What is still on its way, or undefined once every open end has read all the other end wrote. */
  const outstanding = (): string | undefined => {
    for (const end of ends) {
      if (end.isClosed) { ends.delete(end); continue }
      if (end.backlogged) return 'a message is still being compressed or waiting for its socket to drain'
      const socket = socketOf(end)
      const other = [...ends].find(candidate => candidate !== end && !candidate.isClosed && socketOf(candidate).localPort === socket.remotePort && socketOf(candidate).remotePort === socket.localPort)
      if (!other) return 'a socket\'s other end has not opened, or has closed and this end has not heard'
      if (socket.bytesWritten !== socketOf(other).bytesRead) return 'one end has not read all the other wrote'
    }
    return undefined
  }
  const delivered = async (): Promise<void> => {
    const deadline = realNow() + DELIVERY_DEADLINE_MS
    for (let left = outstanding(); left !== undefined; left = outstanding()) {
      if (realNow() > deadline) throw new Error(`The host's sockets did not settle in ${DELIVERY_DEADLINE_MS / 1_000} s: ${left}.`)
      await delay(1)
    }
  }
  return { idle: () => outstanding() === undefined, delivered, dispose: () => { prototype.feed = nativeFeed } }
}

type Peer = Awaited<ReturnType<typeof rawPeer>>

export interface HostSocketScale {
  readonly p: OwnerScalePipeline
  /** The desktop, on the host's own listener, recorded as a desktop: it negotiates compression and is sent Watcher's projection. */
  readonly desktop: Peer
  /** The iPhone, on the phone listener. */
  readonly phone: Peer
  /** What the desktop's hello accepted: what Sotto's own client of a paired host accepts of this host (`SocketHostService`). */
  readonly desktopAccepts: readonly string[]
  /** What the phone's hello accepted: the iPhone's own list, read from its Swift source. */
  readonly phoneAccepts: readonly string[]
  /** Each hello's answer, in bytes of JSON. */
  readonly helloBytes: { readonly desktop: number; readonly phone: number }
  /** Whether the desktop read its Watcher's projection, so the host pushes it `watcher-state`: on Owl, where Watcher runs. */
  readonly watcherReads: boolean
  /** The threads that stream, as this host names them, in order. */
  readonly streamIds: readonly string[]
  /** Sotto's own client of this host, paired as a third client and connected, for a benchmark of the desktop's own work. */
  readonly client: SocketHostService
  readonly hostId: string
  /**
   * The test's clock, stepped only once every socket's ends have read what the other wrote, so the host never finds a peer
   * behind because the machine was slow to compress or to read: every push it makes goes, and the count of pushes is the
   * same on any machine. Step it rather than the test's own clock once the host is built.
   */
  readonly clock: StepClock
  /** Sends `operation` from `peer` and waits for its answer. */
  ask(peer: Peer, id: string, operation: Record<string, unknown>): Promise<Record<string, unknown>>
  /**
   * `chunks` chunks of a reply to `reply` in each of `sessions`, twenty a second as a provider streams them. Every
   * `usageEvery` chunks the thread's token usage moves, as Claude's adapter reports it while a reply streams; that is what
   * a phone, which reads no reply text in a thread list push, is pushed a thread list for.
   */
  stream(sessions: readonly string[], reply: string, chunks: number, usageEvery?: number): Promise<void>
  close(): Promise<void>
}

/**
 * A host at forge's scale with a desktop and an iPhone paired and connected over its socket (November 10, 2026 audit):
 * owner-scale main holding what a running host holds (`ownerScalePipeline`'s `host`), its own listener with the desktop
 * recorded as a desktop, and a phone listener. The desktop says hello with what Sotto's own client of a paired host
 * accepts, found by connecting that client and reading its hello, and reads its Watcher's projection with no call, as
 * the desktop's Watcher does, so the host pushes it `watcher-state` (`docs/host-protocol.md`, "Watcher on a paired host").
 * The phone says hello with the iPhone's own list. Neither observes a thread yet. `prepare` runs on main before any
 * client connects. Every step of `testClock` from here on waits for the sockets as well (`clock`).
 */
export async function hostSocketScale(root: string, testClock: StepClock, options: { track?: OwnerScaleTrack; scale?: OwnerScale; storeWorker?: string | undefined
  prepare?: (p: OwnerScalePipeline) => Promise<void> } = {}): Promise<HostSocketScale> {
  const delivery = socketDelivery()
  try { return await built(root, testClock, delivery, options) } catch (error) { delivery.dispose(); throw error }
}

async function built(root: string, testClock: StepClock, delivery: ReturnType<typeof socketDelivery>, options: Parameters<typeof hostSocketScale>[2] = {}): Promise<HostSocketScale> {
  const track = options.track ?? 'owl', owl = track === 'owl'
  const clock = stepClock(async () => { for (;;) { await testClock.settle(); if (delivery.idle()) return; await delivery.delivered() } })
  const settle = async (done: () => boolean, what: string): Promise<void> => {
    for (let waited = 0; !done(); waited++) { if (waited > 4_000) throw new Error(what); await clock.step() }
  }
  // Paired before main is built, so main's Watcher record can hold the desktop's work under the desktop's own pairing.
  const pairing = new PairedClients(root)
  await clock.until(pairing.load())
  const pair = async (name: string) => clock.until(pairing.redeem(pairing.issuePairingCode().code, name))
  const desktopPairing = await pair('Desktop'), phonePairing = await pair('iPhone'), clientPairing = await pair('Main desktop')
  const p = await clock.until(ownerScalePipeline(root, options.scale ?? { threads: 1, history: 1 }, 3, track,
    { storeWorker: options.storeWorker, host: { desktop: { clientId: desktopPairing.clientId, master: DESKTOP_WATCHER } } }))
  // A host that has run a few seconds, as forge's had: a provider that is turned on but did not connect at start is
  // reconnected 5 s later (`scheduleProviderReconnects`), and its models join the catalog. Before any client connects, so
  // the catalog a client is sent first is the one it keeps, rather than a whole catalog arriving in what is counted.
  await clock.pass(6_000)
  await options.prepare?.(p)
  const service = new LocalHostService({ control: p.control, events: p.workspace, ...(p.watcher ? { watcher: p.watcher } : {}) })
  // Recorded as desktops, as the launch script records a desktop that pairs over SSH: forge's host knows the laptop so.
  const desktops = new Set([desktopPairing.clientId, clientPairing.clientId])
  const server = await clock.until(startSocketServer({ service, pairing, port: 0, watcherDesktops: { refresh: async () => undefined, has: id => desktops.has(id) } }))
  // Phones on a listener of their own, as the desktop's phone listener runs (admin: false): its peers are phones.
  const phoneServer = await clock.until(startSocketServer({ service, pairing, port: 0, admin: false, observationKey: 'phones' }))
  const hostId = p.control.hostId()!

  // Sotto's own client of this host, with the switches an Owl or a stable desktop gives it. What its hello accepts is
  // what the desktop accepts of this host, its features filtered by what the host offers.
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: clientPairing.token, watcherEnabled: owl, crossMachineEnabled: owl,
    pairedHostBrowser: owl, ...(owl ? { nextPromptsWanted: () => true } : {}), productEventAnswer: () => 'off' })
  let accepted: string[] | undefined
  const inner = client as unknown as { call(operation: { op: string; accepts?: string[] }, ...rest: unknown[]): Promise<unknown> }
  const call = inner.call.bind(client)
  inner.call = (operation, ...rest) => { if (operation.op === 'hello') accepted = [...operation.accepts ?? []]; return call(operation, ...rest) }
  {
    let failure: unknown, done = false
    void client.connect().then(() => { done = true }, error => { failure = error; done = true })
    await settle(() => done, 'The desktop\'s client did not connect')
    if (failure !== undefined || !accepted) throw new Error(`The desktop's client did not connect: ${String(failure)}`)
  }
  const desktopAccepts = accepted, phoneAccepts = iphoneAccepts()

  const desktopSession = pairing.signSession(desktopPairing.clientId), phoneSession = pairing.signSession(phonePairing.clientId)
  const desktop = await rawPeer(server.descriptor.port, desktopSession, { offer: 'permessage-deflate; client_no_context_takeover; server_no_context_takeover' })
  const phone = await rawPeer(phoneServer.descriptor.port, phoneSession)
  const sessions = new Map<Peer, string>([[desktop, desktopSession], [phone, phoneSession]])
  const ask = async (peer: Peer, id: string, operation: Record<string, unknown>): Promise<Record<string, unknown>> => {
    peer.frames.send({ v: 1, id, session: sessions.get(peer), ...operation })
    await settle(() => peer.messages.some(message => message.id === id), `No answer to ${id}`)
    return peer.messages.find(message => message.id === id)!
  }
  const hello = { desktop: await ask(desktop, 'hello', { op: 'hello', afterSeq: Number.MAX_SAFE_INTEGER, accepts: desktopAccepts }),
    phone: await ask(phone, 'hello', { op: 'hello', afterSeq: Number.MAX_SAFE_INTEGER, accepts: phoneAccepts }) }
  if (hello.desktop.ok !== true || hello.phone.ok !== true) throw new Error('The host refused a hello.')
  const helloBytes = { desktop: Buffer.byteLength(JSON.stringify(hello.desktop)), phone: Buffer.byteLength(JSON.stringify(hello.phone)) }
  // The desktop's Watcher reads its projection with no call, which registers it for pushes, as `scheduleRemote` does.
  const features = (hello.desktop.result as { features?: string[] } | undefined)?.features ?? []
  const watcherReads = desktopAccepts.includes('watcher-reads') && features.includes('watcher-reads')
  if (watcherReads) {
    const read = await ask(desktop, 'watcher-scope', { op: 'watcher-read', request: { master: DESKTOP_WATCHER } })
    if (read.ok !== true) throw new Error('The host refused the desktop\'s read of its Watcher.')
  }
  const streamIds = p.streamSessions.map(session => p.control.shell().host.threads.find(thread => thread.title === `Synthetic thread ${session}`)?.id).filter((id): id is string => id !== undefined)

  const stream = async (streaming: readonly string[], reply: string, chunks: number, usageEvery = 10): Promise<void> => {
    for (let chunk = 0; chunk < chunks; chunk++) {
      for (const session of streaming) {
        p.adapter.log.appendText(session, reply, ` word${chunk} and some more text`)
        if ((chunk + 1) % usageEvery === 0) {
          const thread = p.adapter.state.threads.find(item => item.id === session)!
          thread.usage = grown(thread.usage)
          p.adapter.mark(session)
        }
      }
      p.adapter.publish(true)
      await clock.pass(50)
    }
  }
  const close = async (): Promise<void> => {
    try {
      await client.close()
      desktop.frames.close(); phone.frames.close()
      await clock.until(server.close()); await clock.until(phoneServer.close()); await clock.until(p.stop())
    } finally { delivery.dispose() }
  }
  return { p, desktop, phone, desktopAccepts, phoneAccepts, helloBytes, watcherReads, streamIds, client, hostId, clock, ask, stream, close }
}

/** Usage after another stretch of a reply: a few hundred tokens more, the context fuller. */
export function grown(usage: AgentThread['usage']): AgentThread['usage'] {
  if (!usage?.latest || !usage.total) return usage
  return { ...usage, latest: { ...usage.latest, output: (usage.latest.output ?? 0) + 240 }, total: { ...usage.total, output: (usage.total.output ?? 0) + 240 },
    contextUsed: (usage.contextUsed ?? 0) + 240 }
}

export interface PartTally { bytes: number; unchanged: number }
/** What a peer was sent of one event, or of answers (`reply`). */
export interface EventTally {
  frames: number; bytes: number; deflated: number; max: number; bytesPerFrame: number; deflatedPerFrame: number
  /**
   * For a push, how many of a frame's parts, and of their bytes, were as the last frame of the same event had them, and
   * each part's bytes over every frame. A part is a top-level field of the frame, with a shell's `state` and its `host`,
   * and Watcher's `projection`, counted field by field (`state.host.projects`, `projection.requests`). A field added to a
   * push is one more part, and one more unchanged part whenever it repeats.
   */
  unchangedPartsPerFrame?: number; unchangedBytesPerFrame?: number; parts?: Record<string, PartTally>
}
/**
 * The pushes that told the desktop only where its Watcher's watched threads have got, whichever event carried them: a whole
 * `watcher-state` whose other parts were as the last one had them, or a `watcher-progress`, which carries the progress
 * alone (#2391, `docs/host-protocol.md`, "Progress pushes").
 */
export interface ProgressTally {
  changes: number; bytesPerChange: number; deflatedPerChange: number; unchangedPartsPerChange: number
  /** Of those, whole `watcher-state` pushes: every request and operation sent again for a step of progress. */
  wholePushes: number; wholePushesPerChange: number
}
export interface PeerTally {
  events: Record<string, EventTally>
  progressOnly?: ProgressTally
  /** The size of Watcher's record in the last `watcher-state`. */
  watcherRecord?: { requests: number; operations: number; progress: number }
}

/** Fields whose own fields are counted as parts: a shell's state and its host, and Watcher's projection. */
const OPENED = new Set(['state', 'state.host', 'projection'])
/** Each part of a push, as JSON, by name: every top-level field, with the `OPENED` ones counted field by field. */
function partsOf(value: Record<string, unknown>, prefix = '', parts = new Map<string, string>()): Map<string, string> {
  for (const [key, field] of Object.entries(value)) {
    const name = prefix + key
    if (OPENED.has(name) && typeof field === 'object' && field !== null && !Array.isArray(field)) partsOf(field as Record<string, unknown>, `${name}.`, parts)
    else parts.set(name, JSON.stringify(field))
  }
  return parts
}
/** The parts of a projection that move when only a watched thread's progress does. */
const MOVES_WITH_PROGRESS = new Set(['projection.progress', 'projection.revision', 'projection.observedAt'])
function onlyProgressMoved(before: Map<string, string>, after: Map<string, string>): boolean {
  if (before.get('projection.progress') === after.get('projection.progress')) return false
  for (const key of new Set([...before.keys(), ...after.keys()])) if (!MOVES_WITH_PROGRESS.has(key) && before.get(key) !== after.get(key)) return false
  return true
}

/**
 * What `messages` from `from` on are, by event: frames, bytes of JSON, and bytes at deflate level 6 when `deflate`, as a
 * desktop's permessage-deflate sends them; for each push, its parts' bytes and how many were as the last push of the same
 * event had them, the last before `from` included; and the pushes that carried only Watcher's progress.
 */
export function tallyPeer(messages: readonly Record<string, unknown>[], from: number, deflate: boolean): PeerTally {
  const totals = new Map<string, { frames: number; bytes: number; deflated: number; max: number; push: boolean; unchangedParts: number; unchangedBytes: number; parts: Record<string, PartTally> }>()
  const progress = { changes: 0, bytes: 0, deflated: 0, unchangedParts: 0, wholePushes: 0 }
  let watcherRecord: PeerTally['watcherRecord']
  /** Each event's last push, as parts: what the next push of that event is measured against. */
  const last = new Map<string, Map<string, string>>()
  for (let index = from - 1; index >= 0; index--) {
    const event = messages[index]!.event
    if (typeof event === 'string' && !last.has(event)) last.set(event, partsOf(messages[index]!))
  }
  for (const message of messages.slice(from)) {
    const text = JSON.stringify(message), bytes = Buffer.byteLength(text)
    const deflated = deflate ? deflateRawSync(text, { level: 6 }).byteLength : 0
    const event = typeof message.event === 'string' ? message.event : undefined
    const name = event ?? (message.id !== undefined ? 'reply' : 'other')
    let total = totals.get(name)
    if (!total) totals.set(name, total = { frames: 0, bytes: 0, deflated: 0, max: 0, push: event !== undefined, unchangedParts: 0, unchangedBytes: 0, parts: {} })
    total.frames++; total.bytes += bytes; total.deflated += deflated; total.max = Math.max(total.max, bytes)
    if (event === undefined) continue
    const parts = partsOf(message), before = last.get(event)
    let unchanged = 0
    for (const [key, value] of parts) {
      const part = total.parts[key] ??= { bytes: 0, unchanged: 0 }, size = Buffer.byteLength(value)
      part.bytes += size
      if (before?.get(key) === value) { part.unchanged++; unchanged++; total.unchangedBytes += size }
    }
    total.unchangedParts += unchanged
    last.set(event, parts)
    if (event === 'watcher-progress' || event === 'watcher-state' && before !== undefined && onlyProgressMoved(before, parts)) {
      progress.changes++; progress.bytes += bytes; progress.deflated += deflated; progress.unchangedParts += unchanged
      if (event === 'watcher-state') progress.wholePushes++
    }
    if (event === 'watcher-state') {
      const projection = message.projection as Record<string, unknown[] | undefined> | undefined
      watcherRecord = { requests: projection?.requests?.length ?? 0, operations: projection?.operations?.length ?? 0, progress: projection?.progress?.length ?? 0 }
    }
  }
  const per = (sum: number, count: number): number => count ? Math.round(sum / count) : 0
  const per2 = (sum: number, count: number): number => count ? Math.round(sum / count * 100) / 100 : 0
  const events = Object.fromEntries([...totals].map(([name, { push, unchangedParts, unchangedBytes, parts, ...total }]): [string, EventTally] => [name, {
    ...total, bytesPerFrame: per(total.bytes, total.frames), deflatedPerFrame: per(total.deflated, total.frames),
    ...push ? { unchangedPartsPerFrame: per2(unchangedParts, total.frames), unchangedBytesPerFrame: per(unchangedBytes, total.frames),
      parts: Object.fromEntries(Object.entries(parts).sort((a, b) => b[1].bytes - a[1].bytes)) } : {},
  }]))
  return {
    events,
    ...progress.changes ? { progressOnly: { changes: progress.changes, bytesPerChange: per(progress.bytes, progress.changes), deflatedPerChange: per(progress.deflated, progress.changes),
      unchangedPartsPerChange: per2(progress.unchangedParts, progress.changes), wholePushes: progress.wholePushes, wholePushesPerChange: per2(progress.wholePushes, progress.changes) } } : {},
    ...watcherRecord ? { watcherRecord } : {},
  }
}
