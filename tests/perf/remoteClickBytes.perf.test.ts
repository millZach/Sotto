// @vitest-environment node
/**
 * What a click in the sidebar on a paired host's thread puts on the wire (#1990): the window's ask reads the thread whole,
 * and its pane then observes it. A host holds a thread's messages only while something observes it (ADR-0016), so how
 * much the read carries depends on whether the host holds the thread: one Watcher watches, a delegation or a queued
 * follow-up waits on, or a phone shows is read whole, and the observe sends it again; one nothing holds is read with no
 * history, and the observe brings it. A desktop that accepts `detail-read-held` is not sent the history again by the
 * observe when it stands as it was read, which saves the second copy of a held thread and changes nothing for the other. The host is a real socket listener with
 * `permessage-deflate` on, and the desktop accepts what the desktop's own host client accepts for a thread: deltas and
 * cut activity bodies. Every byte the desktop's socket receives from the read to the observe's answer is counted.
 *
 * The default run uses a seeded thread, so its counts are the same on every run, and asserts that the click costs one
 * copy rather than two. With a data folder it measures the stored histories in it instead, each as its host holds it,
 * read from a snapshot copied to a temporary folder, since opening a store may migrate it:
 *
 *   SOTTO_PERF_BENCH=1 SOTTO_PERF_DATA=<folder with workspace.json and threads.sqlite> npx vitest run tests/perf/remoteClickBytes.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { ThreadStore } from '../../src/main/agents/threadStore'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentHostSnapshot, AgentThreadDetail, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { round } from '../fixtures/perfBench'
import { copyPerfHistory, perfDataDirectory } from '../fixtures/perfWorkspace'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const THREAD = 'clicked'
const ACCEPTS = ['detail-delta', 'activity-bodies']

/** A seeded generator (mulberry32), so the thread is the same on every run and machine. */
function seeded(seed: number): () => number {
  return () => {
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}
/** 300 records of command output and 60 messages, words from a small vocabulary so they compress as a codebase's do. */
function seededThread(): AgentThreadDetail {
  const random = seeded(1990)
  const words = Array.from({ length: 300 }, (_, index) => `${['host', 'thread', 'detail', 'socket', 'read', 'held'][index % 6]}${Math.floor(random() * 9_000)}`)
  const text = (length: number): string => { let value = ''; while (value.length < length) value += words[Math.floor(random() * words.length)] + (random() < 0.1 ? '\n' : ' '); return value }
  const at = '2026-11-21T09:00:00.000Z'
  const activities: AgentActivity[] = Array.from({ length: 300 }, (_, index) => ({ id: `activity-${index}`, turnId: `turn-${Math.floor(index / 30)}`, sequence: index,
    kind: 'command', status: 'completed', title: `Ran ${text(30)}`, command: text(80), output: text(random() < 0.2 ? 12_000 : 1_500), exitCode: 0 }))
  const messages = Array.from({ length: 60 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: text(600), createdAt: at }))
  return { threadId: THREAD, revision: 1, messages, activities }
}

/**
 * The bytes a click puts on the wire to a desktop that accepts `accepts`, on a host whose thread has `history`, and how
 * many copies of the history it sent. `held`: the host holds the thread's messages before the click, as it does for one
 * something else observes; otherwise it holds them from the observe on, and a read before it finds none.
 */
async function clickBytes(history: AgentThreadDetail, accepts: readonly string[], held = true): Promise<{ bytes: number; wholes: number }> {
  let emit: (update: AgentThreadDetailUpdate) => void = () => undefined
  let observed = held
  const current = (): AgentThreadDetail => observed ? structuredClone({ ...history, threadId: THREAD, revision: 2 }) : { threadId: THREAD, revision: 1, messages: [], activities: [] }
  const service: HostService = {
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadProvider: () => 'codex',
    threadDetail: id => id === THREAD ? current() : null,
    command: (command, identity) => {
      if (command.type === 'observe-threads' && command.threadIds.includes(THREAD)) { observed = true; emit(current()) }
      return fixture.host.service.command(command, identity)
    },
    events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
    subscribeThreadDetail: listener => { emit = listener; return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Click bytes')
  const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId), { offer: 'permessage-deflate' })
  try {
    expect(peer.extensions).toContain('permessage-deflate')
    await peer.call('hello', { op: 'hello', accepts })
    let bytes = 0
    peer.stream.on('data', (chunk: Buffer) => { bytes += chunk.length })
    const read = await peer.call('read', { op: 'detail', threadId: THREAD })
    await peer.call('observe', { op: 'observe', threadIds: [THREAD] })
    // The observe's whole is the first update on its thread's publishing lane, which goes at once, inside the observe and
    // ahead of its answer on the same socket: by the answer, the click has sent all it sends.
    const copies = [read.result, ...peer.messages.filter(message => message.event === 'detail' && message.threadId === THREAD).map(message => message.detail)]
    return { bytes, wholes: copies.filter(copy => (copy as AgentThreadDetail).messages.length > 0).length }
  } finally { peer.frames.close(); await server.close() }
}

describe('a click in the sidebar on a paired host’s thread', async () => {
  it('sends a seeded thread the host holds once rather than twice to a desktop that accepts detail-read-held', async () => {
    const history = seededThread()
    const before = await clickBytes(history, ACCEPTS)
    const after = await clickBytes(history, [...ACCEPTS, 'detail-read-held'])
    expect(before.wholes).toBe(2)
    expect(after.wholes).toBe(1)
    // The second copy was most of what the click cost.
    expect(after.bytes).toBeLessThan(before.bytes * 0.6)
  }, 60_000)

  it('sends a seeded thread the host does not hold once, before and after', async () => {
    const history = seededThread()
    const before = await clickBytes(history, ACCEPTS, false)
    const after = await clickBytes(history, [...ACCEPTS, 'detail-read-held'], false)
    expect(before.wholes).toBe(1)
    expect(after.wholes).toBe(1)
    expect(Math.abs(after.bytes - before.bytes)).toBeLessThan(before.bytes * 0.05)
  }, 60_000)

  const dataDirectory = await perfDataDirectory()
  const store = dataDirectory === null ? null : await access(join(dataDirectory, 'threads.sqlite')).then(() => join(dataDirectory, 'threads.sqlite'), () => null)
  describe('requires SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA containing workspace.json and threads.sqlite', () => {
    it.skipIf(store === null)('reports the bytes of a click on each stored history, before and after', async () => {
      const workspace = JSON.parse(await readFile(join(dataDirectory!, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
      const copy = await mkdtemp(join(tmpdir(), 'sotto-click-bytes-'))
      const rows: Record<string, unknown>[] = []
      let threads: ThreadStore | undefined
      try {
        await copyPerfHistory(dataDirectory!, copy)
        threads = new ThreadStore(join(copy, 'threads.sqlite'), undefined, null)
        threads.open()
        for (const thread of workspace.snapshot.threads) {
          if (!threads.hasActivities(thread.id)) continue
          const history: AgentThreadDetail = { threadId: THREAD, revision: 1, messages: threads.readMessages(thread.id).messages, activities: threads.readActivities(thread.id) }
          const before = await clickBytes(history, ACCEPTS), after = await clickBytes(history, [...ACCEPTS, 'detail-read-held'])
          const unheld = await clickBytes(history, ACCEPTS, false), unheldAfter = await clickBytes(history, [...ACCEPTS, 'detail-read-held'], false)
          expect(after.wholes).toBe(1)
          rows.push({ activities: history.activities!.length, heldBeforeKB: round(before.bytes / 1024, 0), heldAfterKB: round(after.bytes / 1024, 0),
            heldCopies: `${before.wholes} → ${after.wholes}`, unheldBeforeKB: round(unheld.bytes / 1024, 0), unheldAfterKB: round(unheldAfter.bytes / 1024, 0),
            unheldCopies: `${unheld.wholes} → ${unheldAfter.wholes}` })
        }
      } finally { threads?.close(); await rm(copy, { recursive: true, force: true }) }
      expect(rows.length).toBeGreaterThan(0)
      console.table(rows)
    }, 600_000)
  })
})
