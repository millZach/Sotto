// @vitest-environment node
/**
 * Sotto's short writing as a side call to a thread's own client (ADR-0026), over each adapter's fake CLI:
 * what the call is launched with, that it can do nothing but write, and that every way it fails is a
 * rejection or a null rather than anything the thread's own session sees. The contract case in
 * `adapterContract.ts` covers the success path and the thread's silence for every adapter.
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHost } from '../../src/main/agents/host'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const prompt = { instruction: 'Name this coding conversation.', material: 'First message:\nFix the dark theme contrast' }

/** A connected adapter holding one thread in the fixture's own project folder. */
async function opened<F extends { host: AgentHost; root: string; projectId: string; modelId: string; cleanup(): Promise<void> }>(fixture: Promise<F>): Promise<F & { id: string }> {
  const f = await fixture
  cleanups.push(() => f.cleanup())
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Side writing' })
  return { ...f, id }
}

const recorded = async (root: string): Promise<Record<string, unknown>[]> =>
  (await readFile(join(root, 'oneshot.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)

describe('Claude Code side writing', () => {
  it('runs one print with no tools, no session file, the lowest effort and the material on stdin alone', async () => {
    const f = await opened(claudeFixture())
    await expect(f.host.writeShortText!(f.id, prompt)).resolves.toBe('Fixture title')
    const [call] = await recorded(f.root)
    const args = call!.args as string[]
    const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1]
    expect(args).toEqual(expect.arrayContaining(['--print', '--safe-mode', '--no-session-persistence']))
    expect([after('--tools'), after('--permission-prompts'), after('--output-format'), after('--model'), after('--effort')]).toEqual(['', 'none', 'json', 'fixture-model', 'low'])
    expect(after('--system-prompt')).toBe(prompt.instruction)
    expect(args.join(' ')).not.toContain('Fix the dark theme contrast')
    expect(call!.input).toBe(prompt.material)
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--session-id')
  })

  it('rejects a failed run, and answers null for a thread it does not hold or while disconnected', async () => {
    const f = await opened(claudeFixture())
    await writeFile(join(f.root, 'oneshot.json'), JSON.stringify({ fail: true }))
    await expect(f.host.writeShortText!(f.id, prompt)).rejects.toThrow()
    await expect(f.host.writeShortText!(randomUUID(), prompt)).resolves.toBeNull()
    f.host.disconnect()
    await expect(f.host.writeShortText!(f.id, prompt)).resolves.toBeNull()
  })
})

describe('stopping a side call', () => {
  it('ends the client the call started when its signal aborts, well before the call would have finished', async () => {
    const f = await opened(claudeFixture())
    await writeFile(join(f.root, 'oneshot.json'), JSON.stringify({ delayMs: 60_000 }))
    const stop = new AbortController()
    const pending = f.host.writeShortText!(f.id, prompt, stop.signal)
    await expect.poll(async () => (await recorded(f.root)).length).toBe(1)
    stop.abort()
    // The fake holds its answer for a minute, past this test's deadline, and would then succeed, so a
    // rejection inside the deadline is the abort ending the call; no stopwatch is needed to show it.
    await expect(pending).rejects.toThrow()
  })
})

describe('Codex side writing', () => {
  it('runs an ephemeral, read-only, tool-free exec with the prompt on stdin', async () => {
    const f = await opened(codexFixture())
    await expect(f.host.writeShortText!(f.id, prompt)).resolves.toBe('Fixture title')
    const [call] = await recorded(f.root)
    const args = call!.args as string[]
    expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--skip-git-repo-check', '--json', 'approval_policy="never"', 'mcp_servers={}', 'project_doc_max_bytes=0', 'history.persistence="none"',
      'features.skip_host_skill_discovery=true', 'orchestrator.skills.enabled=false', 'orchestrator.mcp.enabled=false', 'instructions=""']))
    expect(args).not.toContain('approval_policy="on-request"')
    expect(args[args.indexOf('--model') + 1]).toBe('fixture-model')
    expect(args.at(-1)).toBe('-')
    expect(args.join(' ')).not.toContain('Fix the dark theme contrast')
    expect(call!.input).toBe(`${prompt.instruction}\n\n${prompt.material}`)
  })

  it('stops a call that reaches for a tool, and rejects a failed turn', async () => {
    const f = await opened(codexFixture())
    await writeFile(join(f.root, 'oneshot.json'), JSON.stringify({ tool: true }))
    await expect(f.host.writeShortText!(f.id, prompt)).rejects.toThrow('tried to use a tool')
    await writeFile(join(f.root, 'oneshot.json'), JSON.stringify({ fail: true }))
    await expect(f.host.writeShortText!(f.id, prompt)).rejects.toThrow()
    await expect(f.host.writeShortText!(randomUUID(), prompt)).resolves.toBeNull()
  })
})

describe('Grok side writing', () => {
  it('opens a tool-free session of its own on a throwaway home at the lowest effort, and removes the home', async () => {
    const f = await opened(grokFixture())
    await expect(f.host.writeShortText!(f.id, prompt)).resolves.toBe('Fixture title')
    const frames = (await recorded(f.root)).map(call => call.frame as { method?: string; params?: Record<string, unknown> })
    expect(frames.map(frame => frame.method)).toEqual(['initialize', 'authenticate', 'session/new', 'session/set_model', 'session/prompt'])
    expect(frames[3]!.params).toMatchObject({ modelId: 'fixture-model', _meta: { reasoningEffort: 'low' } })
    expect(frames[4]!.params).toMatchObject({ prompt: [{ type: 'text', text: `${prompt.instruction}\n\n${prompt.material}` }] })
    expect(String((frames[2]!.params!._meta as { systemPromptOverride: string }).systemPromptOverride)).toContain(prompt.instruction)
    // The call's own process ran with a Grok home Sotto made for it, and that home is gone again.
    const [call] = await recorded(f.root)
    expect(String(call!.home)).toContain(join(f.root, 'writing', 'grok'))
    expect(await readdir(join(f.root, 'writing', 'grok'))).toEqual([])
    // The thread's leader never saw a prompt or a session it did not own.
    expect(JSON.stringify(await f.driver.requests())).not.toContain('Fix the dark theme contrast')
  })

  it('rejects a failed prompt and answers null for a thread it does not hold', async () => {
    const f = await opened(grokFixture())
    await writeFile(join(f.root, 'oneshot.json'), JSON.stringify({ fail: true }))
    await expect(f.host.writeShortText!(f.id, prompt)).rejects.toThrow()
    await expect(f.host.writeShortText!(randomUUID(), prompt)).resolves.toBeNull()
  })
})

describe('Devin side writing', () => {
  it('offers none: Devin has no headless one-shot path, so its threads keep their placeholder', async () => {
    const f = await opened(devinFixture())
    const host: AgentHost = f.host
    expect(host.writeShortText).toBeUndefined()
  })
})
