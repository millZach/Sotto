// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../src/shared/agentActivity'

/** A thinking block's signature that marks it narration, which the Claude adapter takes back out of its list. */
function narrationSignature(): string {
  const name = Buffer.from('narration')
  const kind = Buffer.concat([Buffer.from([0x42, name.length]), name])
  const envelope = Buffer.concat([Buffer.from([0x0a, kind.length]), kind])
  return Buffer.concat([Buffer.from([0x12, envelope.length]), envelope]).toString('base64')
}

/** The tool steps of a list, by sequence, as the step numbers they were written with. */
const stepOrder = (records: readonly AgentActivity[]): number[] => records.filter(record => record.id.startsWith('claude-tool-'))
  .sort((a, b) => a.sequence - b.sequence).map(record => Number(record.id.replace('claude-tool-toolu_', '')))
const ascending = (order: readonly number[]): boolean => order.every((value, index) => index === 0 || value > order[index - 1]!)

describe('a Claude thread past the step limit (#2330)', () => {
  let f: Awaited<ReturnType<typeof claudeFixture>>
  let id: string
  beforeEach(async () => {
    f = await claudeFixture(); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Long', modelId: f.modelId })
  })
  afterEach(async () => { await f.cleanup() })

  it('keeps its steps numbered in the order they ran after the adapter takes a row back, and across a restart', async () => {
    const registryDirectory = join(f.root, 'identity'), workspaceDirectory = join(f.root, 'workspace')
    const registry = new ThreadRegistry(registryDirectory); await registry.load()
    const sottoId = randomUUID(); registry.reserve(sottoId, 'claude', id, f.projectId); await registry.flush()
    let workspace = new WorkspaceHost(new SottoThreadHost('claude', f.host, registry), workspaceDirectory)
    await workspace.connect()
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const start = Date.parse('2026-11-07T20:00:00.000Z')
    const line = (n: number, content: unknown, messageId = `msg_${n}`): string => JSON.stringify({ type: 'assistant', uuid: randomUUID(), sessionId: session,
      timestamp: new Date(start + n * 1000).toISOString(), message: { id: messageId, role: 'assistant', model: 'fixture-model', content: [content] } }) + '\n'
    let step = 0
    const steps = (count: number): string => Array.from({ length: count }, () => {
      const n = step++
      return line(n, { type: 'tool_use', id: `toolu_${String(n).padStart(6, '0')}`, name: 'Bash', input: { command: `echo ${n}` } })
    }).join('')
    const poll = async (text: string) => { await appendFile(path, text); await f.adapter.pollSessionLogs(); await workspace.snapshot() }
    await appendFile(path, JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date(start - 1000).toISOString(), message: { role: 'user', content: 'Go' } }) + '\n')
    // A long turn's transcript read in chunks. At step 400 a thinking block is read as Thinking, then read again as
    // narration, which the adapter takes back out of its list while the workspace keeps it.
    const total = MAX_AGENT_ACTIVITIES + 600
    for (let written = 0; written < total; written += 200) {
      if (written === 400) {
        const thinking = { type: 'thinking', thinking: 'I will look at it next.' }
        await poll(line(step, thinking, 'msg_seed'))
        await poll(line(step, { ...thinking, signature: narrationSignature() }, 'msg_seed'))
      }
      await poll(steps(200))
    }
    // Stopped as the app stops: the workspace lets go, the adapter closes, the store's last writes land.
    const stop = async () => { workspace.disconnect(); await f.adapter.closed(); await workspace.snapshot().catch(() => undefined); workspace.dispose() }
    const held = async () => (await workspace.snapshot()).threads.find(thread => thread.id === sottoId)?.activities ?? []
    const before = stepOrder(await held())
    expect(ascending(before), 'sequence order before the restart').toBe(true)
    expect(before.at(-1)).toBe(total - 1)

    await stop()
    f = await claudeFixture(f.root)
    workspace = new WorkspaceHost(new SottoThreadHost('claude', f.host, new ThreadRegistry(registryDirectory)), workspaceDirectory)
    await workspace.connect()
    await appendFile(path, steps(5)); await f.adapter.pollSessionLogs()
    const after = stepOrder(await held())
    expect(ascending(after), 'sequence order after the restart').toBe(true)
    expect(after.at(-1)).toBe(total + 4)
    await stop()
    const db = new DatabaseSync(join(workspaceDirectory, 'threads.sqlite'), { readOnly: true })
    try {
      const stored = (db.prepare('SELECT payload FROM activities WHERE thread_id = ?').all(sottoId) as { payload: string }[]).map(row => JSON.parse(row.payload) as AgentActivity)
      expect(ascending(stepOrder(stored)), 'stored sequence order').toBe(true)
    } finally { db.close() }
  }, 120_000)
})
