// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { ACTIVITY_BODY_LIMIT, utf8Bytes } from '../../src/shared/activityBodies'
import { agentActivitySchema, type AgentActivity } from '../../src/shared/agentActivity'
import type { AgentThreadDetail, AgentThreadDetailDelta, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { activitySummary, hostPushSchema } from '../../src/shared/hostProtocol'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const at = '2026-10-18T09:00:00.000Z'
const lines = (count: number, word: string): string => Array.from({ length: count }, (_, index) => `${word} ${index} `.padEnd(48, '.')).join('\n')
const message = { id: 'reply', role: 'assistant' as const, text: 'Done', createdAt: at }
const build: AgentActivity = { id: 'build', turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Run the build', command: 'npm run build',
  cwd: '/synthetic/project', output: lines(400, 'compiled'), startedAt: at, timingSource: 'observed', afterMessageId: 'reply' }
const edit: AgentActivity = { id: 'edit', turnId: 'turn', sequence: 2, kind: 'file-change', status: 'completed', title: 'Edited a file', parentId: 'turn',
  text: JSON.stringify({ file_path: '/synthetic/project/src/a.ts', content: lines(300, 'const') }), changes: [{ path: 'src/a.ts', kind: 'Write', diff: lines(300, '+a') }], durationMs: 40 }
const small: AgentActivity = { id: 'small', turnId: 'turn', sequence: 3, kind: 'command', status: 'completed', title: 'Ran ls', command: 'ls', output: 'a.ts\nb.ts', exitCode: 0 }
const secret: AgentActivity = { ...build, id: 'secret-build' }

/**
 * A host whose observed thread's history the test sets and whose detail stream it drives, as the coordinator does: a
 * thread is published whole the moment a client starts observing it. `opencode-thread` is a thread of a provider a client
 * that does not accept `provider-opencode` may not be sent.
 */
async function bodiesHost(options: { admin?: boolean } = {}) {
  const stream = { current: { threadId: 'streaming', revision: 1, messages: [message], activities: [build, edit, small] } as AgentThreadDetail, emit: ((update: AgentThreadDetailUpdate) => { void update }) as (update: AgentThreadDetailUpdate) => void }
  const hidden: AgentThreadDetail = { threadId: 'opencode-thread', revision: 1, messages: [], activities: [secret] }
  const service: HostService = {
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
    threadProvider: id => id === 'opencode-thread' ? 'opencode' : 'codex',
    threadDetail: id => id === 'streaming' ? structuredClone(stream.current) : id === 'opencode-thread' ? structuredClone(hidden) : null,
    command: (command, identity) => {
      if (command.type === 'observe-threads' && command.threadIds.includes('streaming')) stream.emit(structuredClone(stream.current))
      return fixture.host.service.command(command, identity)
    },
    events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
    subscribeThreadDetail: listener => { stream.emit = listener; return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing, ...(options.admin === false ? { admin: false } : {}) })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Bodies')
  const peer = () => rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  const desktop = async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
    await client.connect(); return client
  }
  return { stream, server, peer, desktop }
}
const detailPush = (messages: Record<string, unknown>[], revision: number) => messages.find(item => item.event === 'detail' && (item.detail as AgentThreadDetail).revision === revision)
const deltaPush = (messages: Record<string, unknown>[], revision: number) => messages.find(item => item.event === 'detail-delta' && (item.delta as AgentThreadDetailDelta).revision === revision)
const records = (detail: unknown): AgentActivity[] => (detail as AgentThreadDetail).activities!

describe('activity bodies over the socket (ADR-0025, October 18 amendment)', () => {
  it('sends a desktop that accepts them cut records with their whole sizes, and answers activity-body with the whole record', async () => {
    const { stream, server, peer } = await bodiesHost()
    const desktop = await peer()
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['detail-delta', 'activity-bodies'] })
      expect((hello.result as { features: string[] }).features).toContain('activity-bodies')
      await desktop.call('observe', { op: 'observe', threadIds: ['streaming'] })
      const pushed = detailPush(desktop.messages, 1)!
      expect(hostPushSchema.parse(pushed)).toEqual(pushed)
      const [cutBuild, cutEdit, sent] = records(pushed.detail)
      expect(cutBuild!.cut).toEqual({ output: utf8Bytes(build.output!) })
      expect(utf8Bytes(cutBuild!.output!)).toBeLessThanOrEqual(ACTIVITY_BODY_LIMIT)
      expect(build.output!.endsWith(cutBuild!.output!)).toBe(true)
      // Every field the desktop shows inline goes whole.
      expect({ ...cutBuild, output: build.output, cut: undefined }).toEqual({ ...build, cut: undefined })
      expect(cutEdit!.cut).toEqual({ text: utf8Bytes(edit.text!), diffs: [{ index: 0, bytes: utf8Bytes(edit.changes![0]!.diff!) }] })
      expect((JSON.parse(cutEdit!.text!) as { file_path: string }).file_path).toBe('/synthetic/project/src/a.ts')
      expect(cutEdit!.parentId).toBe('turn')
      expect(sent).toEqual(small)
      for (const record of records(pushed.detail)) expect(agentActivitySchema.parse(record)).toEqual(record)

      // The row opens: the whole record comes back, and a record the thread no longer has is null.
      expect(await desktop.call('body', { op: 'activity-body', threadId: 'streaming', activityId: 'build' })).toMatchObject({ ok: true, result: build })
      expect(await desktop.call('gone', { op: 'activity-body', threadId: 'streaming', activityId: 'nothing' })).toMatchObject({ ok: true, result: null })
      // So does a detail the desktop reads itself.
      const read = await desktop.call('read', { op: 'detail', threadId: 'streaming' })
      expect(records(read.result)[0]!.cut).toEqual({ output: utf8Bytes(build.output!) })

      // The command's output grew: its delta carries the new cut, with the new whole size.
      const grown: AgentActivity = { ...build, output: build.output + '\n' + lines(50, 'linked') }
      stream.current = { ...stream.current, revision: 2, activities: [grown, edit, small] }
      stream.emit({ threadId: 'streaming', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [{ record: grown }] })
      await expect.poll(() => deltaPush(desktop.messages, 2)).toBeTruthy()
      const delta = deltaPush(desktop.messages, 2)!.delta as AgentThreadDetailDelta
      expect(hostPushSchema.parse(deltaPush(desktop.messages, 2))).toBeTruthy()
      const carried = (delta.activityDeltas[0] as { record: AgentActivity }).record
      expect(carried.cut).toEqual({ output: utf8Bytes(grown.output!) })
      expect(grown.output!.endsWith(carried.output!)).toBe(true)
      expect(carried.output).toContain('linked 49')
    } finally { desktop.frames.close(); await server.close() }
  })

  it('is accepted by the desktop’s own client, which reads a cut record’s whole body on request', async () => {
    const { server, desktop } = await bodiesHost()
    const client = await desktop()
    try {
      await client.observe(['streaming'])
      await expect.poll(() => client.threadDetail('streaming')?.activities?.[0]?.cut).toEqual({ output: utf8Bytes(build.output!) })
      expect(client.threadDetail('streaming')?.activities?.[2]).toEqual(small)
      expect(await client.activityBody('streaming', 'build')).toEqual(build)
      expect(await client.activityBody('streaming', 'edit')).toEqual(edit)
      expect(await client.activityBody('streaming', 'nothing')).toBeNull()
    } finally { await client.close(); await server.close() }
  })

  it('sends whole records to a client that does not accept them, and refuses it activity-body', async () => {
    const { server, peer } = await bodiesHost()
    const older = await peer()
    try {
      await older.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      await older.call('observe', { op: 'observe', threadIds: ['streaming'] })
      expect(detailPush(older.messages, 1)!.detail).toEqual({ threadId: 'streaming', revision: 1, messages: [message], activities: [build, edit, small] })
      expect(JSON.stringify(older.messages)).not.toContain('"cut":')
      expect(await older.call('body', { op: 'activity-body', threadId: 'streaming', activityId: 'build' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    } finally { older.frames.close(); await server.close() }
  })

  it('sends summaries to a client that accepts both, as a phone does', async () => {
    const { server, peer } = await bodiesHost()
    const phone = await peer()
    try {
      await phone.call('hello', { op: 'hello', accepts: ['detail-delta', 'activity-summaries', 'activity-bodies'] })
      await phone.call('observe', { op: 'observe', threadIds: ['streaming'] })
      expect(records(detailPush(phone.messages, 1)!.detail)).toEqual([build, edit, small].map(activitySummary))
      expect(await phone.call('body', { op: 'activity-body', threadId: 'streaming', activityId: 'build' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    } finally { phone.frames.close(); await server.close() }
  })

  it('refuses activity-body for a thread the client may not be sent', async () => {
    const { server, peer } = await bodiesHost()
    const desktop = await peer()
    try {
      // This desktop's hello does not accept `provider-opencode`, so OpenCode's threads are hidden from it (#1107).
      await desktop.call('hello', { op: 'hello', accepts: ['detail-delta', 'activity-bodies'] })
      expect(await desktop.call('hidden', { op: 'activity-body', threadId: 'opencode-thread', activityId: 'secret-build' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    } finally { desktop.frames.close(); await server.close() }
  })

  it('is not offered by the desktop’s own phone listener', async () => {
    const { server, peer } = await bodiesHost({ admin: false })
    const phone = await peer()
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['detail-delta', 'activity-bodies'] })
      expect((hello.result as { features: string[] }).features).not.toContain('activity-bodies')
      expect(server.descriptor.features).not.toContain('activity-bodies')
      await phone.call('observe', { op: 'observe', threadIds: ['streaming'] })
      expect(records(detailPush(phone.messages, 1)!.detail)).toEqual([build, edit, small])
    } finally { phone.frames.close(); await server.close() }
  })
})
