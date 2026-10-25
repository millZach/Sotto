// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexAppServerHost } from '../../../src/main/agents/codex'
import { ClaudeStreamJsonHost } from '../../../src/main/agents/claude'
import { CursorAcpHost } from '../../../src/main/agents/cursor'
import { DeepSeekAcpHost } from '../../../src/main/agents/deepseek'
import { GrokAcpHost } from '../../../src/main/agents/grok'
import { DevinAcpHost } from '../../../src/main/agents/devin'
import { MuseMspHost } from '../../../src/main/agents/muse'
import { OpenCodeHost } from '../../../src/main/agents/opencode'
import type { AgentHostChanges } from '../../../src/main/agents/threadChanges'
import { cursorFixture } from '../../fixtures/fakeCursorFixture'
import { deepseekFixture } from '../../fixtures/fakeDeepSeekFixture'

// ADR-0140: `forgetThread` must remove exactly the one alias asked for, on disk, even when the adapter has never
// connected and so holds no in-memory copy of the store to mutate. Each adapter here is cheap to construct without
// a provider binary, so these exercise the not-loaded, direct-read-modify-write path `forgetThread` falls back to;
// a fully connected round trip (process spawned, snapshot omits the thread) needs each provider's own protocol
// fixture and is out of scope for this file (see the task notes).

const roots: string[] = []
afterEach(async () => { roots.length = 0 })

async function tempUserData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-forget-thread-'))
  roots.push(root)
  return root
}

async function readAliases(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

describe('forgetThread removes one alias without disturbing the rest, unconnected', () => {
  it('codex', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'codex-threads.json')
    const createdAt = new Date().toISOString()
    await writeFile(file, JSON.stringify({
      keep: { codexThreadId: 'native-keep', projectId: 'proj-1', cwd: userDataPath, title: 'Keep', modelId: 'gpt-5', createdAt },
      gone: { codexThreadId: 'native-gone', projectId: 'proj-1', cwd: userDataPath, title: 'Gone', modelId: 'gpt-5', createdAt },
    }))
    const host = new CodexAppServerHost({ userDataPath })
    await host.forgetThread!('gone')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })

  it('claude', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'claude-threads.json')
    const createdAt = new Date().toISOString()
    const alias = (title: string) => ({ sessionId: randomUUID(), projectId: 'proj-1', cwd: userDataPath, title, modelId: 'claude-opus', createdAt })
    await writeFile(file, JSON.stringify({ keep: alias('Keep'), gone: alias('Gone') }))
    const host = new ClaudeStreamJsonHost({ userDataPath })
    await host.forgetThread!('gone')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })

  it('grok', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'grok-threads.json')
    const createdAt = new Date().toISOString()
    const alias = (title: string) => ({ projectId: 'proj-1', cwd: userDataPath, title, modelId: 'grok-5', createdAt, origins: [] })
    await writeFile(file, JSON.stringify({ keep: alias('Keep'), gone: alias('Gone') }))
    const host = new GrokAcpHost(userDataPath)
    await host.forgetThread!('gone')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })

  it('devin', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'devin-threads.json')
    const createdAt = new Date().toISOString()
    const alias = (title: string) => ({ projectId: 'proj-1', cwd: userDataPath, title, modelId: 'devin', createdAt, settingsConfirmed: false, origins: [] })
    await writeFile(file, JSON.stringify({ keep: alias('Keep'), gone: alias('Gone') }))
    const host = new DevinAcpHost(userDataPath)
    await host.forgetThread!('gone')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })

  it('muse', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'muse-threads.json')
    const createdAt = new Date().toISOString()
    const alias = (title: string) => ({ projectId: 'proj-1', cwd: userDataPath, title, modelId: 'muse', createdAt, origins: [] })
    await writeFile(file, JSON.stringify({ keep: alias('Keep'), gone: alias('Gone') }))
    const host = new MuseMspHost(userDataPath)
    await host.forgetThread!('gone')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })

  it('opencode', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'opencode-threads.json')
    const createdAt = new Date().toISOString()
    const alias = (title: string) => ({ createToken: randomUUID(), projectId: 'proj-1', cwd: userDataPath, title, modelId: 'opencode', createdAt })
    await writeFile(file, JSON.stringify({ keep: alias('Keep'), gone: alias('Gone') }))
    const host = new OpenCodeHost(userDataPath)
    await host.forgetThread!('gone')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })

  it('cursor', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'cursor-threads.json')
    const createdAt = new Date().toISOString()
    const alias = (title: string) => ({ projectId: 'proj-1', cwd: userDataPath, title, modelId: 'gpt-fixture', runtimeMode: 'approval-required', createdAt, turns: 0, origins: [] })
    await writeFile(file, JSON.stringify({ keep: alias('Keep'), gone: alias('Gone') }))
    const host = new CursorAcpHost(userDataPath)
    await host.forgetThread!('gone')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })

  it('deepseek', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'deepseek-threads.json')
    const createdAt = new Date().toISOString()
    const alias = (title: string) => ({ projectId: 'proj-1', cwd: userDataPath, title, modelId: 'own-fixture/fixture-model', runtimeMode: 'approval-required', createdAt, origins: [] })
    await writeFile(file, JSON.stringify({ keep: alias('Keep'), gone: alias('Gone') }))
    const host = new DeepSeekAcpHost(userDataPath)
    await host.forgetThread!('gone')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })

  it('forgetting an id the store never had changes nothing', async () => {
    const userDataPath = await tempUserData()
    const file = join(userDataPath, 'codex-threads.json')
    const createdAt = new Date().toISOString()
    await writeFile(file, JSON.stringify({ keep: { codexThreadId: 'native-keep', projectId: 'proj-1', cwd: userDataPath, title: 'Keep', modelId: 'gpt-5', createdAt } }))
    const host = new CodexAppServerHost({ userDataPath })
    await host.forgetThread!('never-existed')
    const aliases = await readAliases(file)
    expect(Object.keys(aliases)).toEqual(['keep'])
  })
})

// Cursor and DeepSeek Harness have fake clients cheap enough to connect here, so their connected path is covered too:
// the thread's process stops, its thread changes drop it, and a connect that read the store before the removal reached
// disk (simulated by writing that stale store back) cannot bring it back.
type ForgetFixture = Awaited<ReturnType<typeof cursorFixture>> | Awaited<ReturnType<typeof deepseekFixture>>
const connectedCases: readonly { name: string; file: string; fixture: (root?: string) => Promise<ForgetFixture> }[] = [
  { name: 'cursor', file: 'cursor-threads.json', fixture: root => cursorFixture(root) },
  { name: 'deepseek', file: 'deepseek-threads.json', fixture: root => deepseekFixture(root) },
]

describe.each(connectedCases)('forgetThread on $name', ({ file, fixture }) => {
  let f: ForgetFixture | undefined
  afterEach(async () => { const previous = f; f = undefined; await previous?.cleanup() })
  const connections = (host: unknown) => (host as { connections: Map<string, unknown> }).connections
  /** A connected fixture holding two threads, `gone` with a session that has a live process. */
  const open = async (): Promise<{ keep: string; gone: string }> => {
    f = await fixture()
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const keep = randomUUID(), gone = randomUUID()
    for (const [id, title] of [[keep, 'Keep'], [gone, 'Gone']] as const) {
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title })
    }
    expect(await f.host.execute({ type: 'send', threadId: gone, commandId: randomUUID(), messageId: 'm1', text: 'Hello' })).toEqual({ accepted: true })
    await f.driver.completeTurn(gone, 'Done.')
    await vi.waitFor(async () => { expect((await f!.host.snapshot()).threads.find(thread => thread.id === gone)?.status).toBe('idle') })
    return { keep, gone }
  }

  it('stops the thread, drops it from its thread changes and the store, and a racing connect cannot bring it back', async () => {
    const { keep, gone } = await open()
    const stale = await readFile(join(f!.root, file), 'utf8')
    expect(Object.keys(JSON.parse(stale) as object).sort()).toEqual([keep, gone].sort())
    expect(connections(f!.host).has(gone)).toBe(true)
    const changes: AgentHostChanges[] = []
    const unsubscribe = f!.host.subscribeActivityChanges(next => { changes.push(next) })
    await f!.host.forgetThread!(gone)
    unsubscribe()
    expect(connections(f!.host).has(gone)).toBe(false)
    expect(changes.some(change => change.removals.includes(gone) || (change.whole === true && !change.upserts.some(thread => thread.id === gone)))).toBe(true)
    expect((await f!.host.snapshot()).threads.map(thread => thread.id)).toEqual([keep])
    expect(Object.keys(await readAliases(join(f!.root, file)))).toEqual([keep])
    // The store as a connect racing the removal read it.
    await writeFile(join(f!.root, file), stale)
    const snapshot = await f!.host.connect()
    expect(snapshot.threads.map(thread => thread.id)).toEqual([keep])
  })

  it('forgets on a host that has not connected, and its first connect keeps the thread gone', async () => {
    const { keep, gone } = await open()
    const stale = await readFile(join(f!.root, file), 'utf8')
    f!.host.disconnect(); await f!.host.closed()
    f = await fixture(f!.root)
    await f.host.forgetThread!(gone)
    expect(Object.keys(await readAliases(join(f.root, file)))).toEqual([keep])
    await writeFile(join(f.root, file), stale)
    expect((await f.host.connect()).threads.map(thread => thread.id)).toEqual([keep])
  })

  it('forgetting an id it never had changes nothing', async () => {
    const { keep, gone } = await open()
    const before = await readFile(join(f!.root, file), 'utf8')
    await f!.host.forgetThread!('never-existed')
    expect(await readFile(join(f!.root, file), 'utf8')).toBe(before)
    expect((await f!.host.snapshot()).threads.map(thread => thread.id).sort()).toEqual([keep, gone].sort())
    expect(connections(f!.host).has(gone)).toBe(true)
  })
})
