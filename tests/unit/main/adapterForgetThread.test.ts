// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CodexAppServerHost } from '../../../src/main/agents/codex'
import { ClaudeStreamJsonHost } from '../../../src/main/agents/claude'
import { GrokAcpHost } from '../../../src/main/agents/grok'
import { DevinAcpHost } from '../../../src/main/agents/devin'
import { MuseMspHost } from '../../../src/main/agents/muse'
import { OpenCodeHost } from '../../../src/main/agents/opencode'

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
