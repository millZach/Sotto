// @vitest-environment node
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeSubagentModels, MAX_SUBAGENT_TRANSCRIPTS, claudeWorkflowModels, type ClaudeModelTarget } from '../../../src/main/agents/claudeSubagentModels'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-claude-subagents-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function session(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-subagents-')); roots.push(root)
  return join(root, 'session-id')
}
const line = (frame: Record<string, unknown>): string => JSON.stringify({ isSidechain: true, agentId: 'agent', sessionId: 'session-id', ...frame }) + '\n'
const task = line({ type: 'user', message: { role: 'user', content: 'PRIVATE_SUBAGENT_TASK' } })
const reply = (model: string): string => line({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_SUBAGENT_REPLY' }] } })
async function agentFile(folder: string, agentId: string, content: string, run?: string): Promise<string> {
  const dir = run ? join(folder, 'subagents', 'workflows', run) : join(folder, 'subagents')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `agent-${agentId}.jsonl`)
  await writeFile(path, content)
  return path
}
const agent = (id: string, agentId = id, settled = false): ClaudeModelTarget => ({ id, transcript: { agentId }, settled })

describe('Claude subagent models from their own transcripts', () => {
  it('reads the first assistant model of a spawned agent and of a workflow run, and nothing else', async () => {
    const folder = await session()
    await agentFile(folder, 'a1b2', task + line({ type: 'attachment', attachment: { type: 'skill_listing' } }) + reply('claude-opus-5-5') + reply('claude-later'))
    await agentFile(folder, 'a3', task + reply('claude-opus-5-5'), 'wf_79f40664-5f1')
    await agentFile(folder, 'a4', task + reply('claude-haiku-4-5'), 'wf_79f40664-5f1')
    const reader = new ClaudeSubagentModels()
    const models = await reader.read(folder, [agent('claude-agent-one', 'a1b2'), { id: 'claude-agent-run', transcript: { runId: 'wf_79f40664-5f1' }, settled: false }])
    expect([...models]).toEqual([['claude-agent-one', 'claude-opus-5-5'], ['claude-agent-run', 'claude-opus-5-5, claude-haiku-4-5']])
    expect(JSON.stringify([...models])).not.toMatch(/PRIVATE/u)
  })

  it('waits for a running agent\'s first reply, reading on from where it stopped', async () => {
    const folder = await session()
    const reader = new ClaudeSubagentModels()
    expect((await reader.read(folder, [agent('child', 'a1')])).size).toBe(0)
    const path = await agentFile(folder, 'a1', task)
    const partial = reply('claude-opus-5-5')
    await appendFile(path, partial.slice(0, 40))
    expect((await reader.read(folder, [agent('child', 'a1')])).size).toBe(0)
    await appendFile(path, partial.slice(40))
    expect((await reader.read(folder, [agent('child', 'a1')])).get('child')).toBe('claude-opus-5-5')
  })

  it('gives up a stopped agent whose transcript never names a model, and skips notices and oversized lines', async () => {
    const folder = await session()
    const path = await agentFile(folder, 'a1', task + line({ type: 'assistant', message: { model: '<synthetic>', content: [] } }) + line({ type: 'user', message: { content: 'x'.repeat(1024 * 1024 + 10) } }))
    const reader = new ClaudeSubagentModels()
    for (let attempt = 0; attempt < 3; attempt++) expect((await reader.read(folder, [agent('child', 'a1', true), agent('missing', 'a9', true)])).size).toBe(0)
    // Written after the reader gave up: a finished agent's transcript is not watched forever.
    await appendFile(path, reply('claude-opus-5-5'))
    expect((await reader.read(folder, [agent('child', 'a1', true)])).size).toBe(0)
    // A running agent past the same lines is still read.
    const fresh = new ClaudeSubagentModels()
    let model: string | undefined
    for (let poll = 0; poll < 10 && !model; poll++) model = (await fresh.read(folder, [agent('child', 'a1')])).get('child')
    expect(model).toBe('claude-opus-5-5')
  })

  it('opens a bounded number of files per poll, in the order the targets come', async () => {
    const folder = await session()
    const targets = Array.from({ length: MAX_SUBAGENT_TRANSCRIPTS + 4 }, (_, index) => agent(`child-${index}`, `a${index}`))
    for (const target of targets) await agentFile(folder, 'agentId' in target.transcript ? target.transcript.agentId : '', task + reply('claude-opus-5-5'))
    const reader = new ClaudeSubagentModels()
    const first = await reader.read(folder, targets)
    expect(first.size).toBe(MAX_SUBAGENT_TRANSCRIPTS)
    expect(first.has('child-0')).toBe(true)
    expect(first.has(`child-${MAX_SUBAGENT_TRANSCRIPTS}`)).toBe(false)
    const rest = await reader.read(folder, targets.filter(target => !first.has(target.id)))
    expect(rest.size).toBe(4)
  })

  it('builds no path from an identifier that is not a native token', async () => {
    const folder = await session()
    await agentFile(folder, 'a1', task + reply('claude-opus-5-5'))
    const reader = new ClaudeSubagentModels()
    const models = await reader.read(folder, [agent('escape', '../subagents/agent-a1'), { id: 'run', transcript: { runId: '..' }, settled: false }])
    expect(models.size).toBe(0)
  })

  it('lists a workflow\'s models once each, in the order seen, up to four', () => {
    expect(claudeWorkflowModels(undefined, [])).toBeUndefined()
    expect(claudeWorkflowModels('claude-opus-5-5', ['claude-opus-5-5', 'claude-haiku-4-5'])).toBe('claude-opus-5-5, claude-haiku-4-5')
    expect(claudeWorkflowModels('a, b', ['c', 'd', 'e'])).toBe('a, b, c, d')
  })
})
