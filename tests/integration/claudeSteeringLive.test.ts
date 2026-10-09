// @vitest-environment node
/**
 * Opt-in live check that a Claude thread steers (ADR-0065). It makes a synthetic project in a temporary folder and runs
 * threads against the installed, signed-in Claude Code, with bypassing allowed so `sleep` needs no answer. Each asks
 * Claude to run `sleep 15`, then say the secret word if it was told one. While the command runs, a steer tells it
 * PELICAN. Read into the running turn, the one reply carries it; written before a stop, it runs as the next turn. It
 * prints which turns the thread recorded and how long each case took; no message text is printed.
 *
 *   PowerShell:  $env:SOTTO_CLAUDE_LIVE = '1'; npx vitest run tests/integration/claudeSteeringLive.test.ts --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeSteeringLive.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import type { AgentThread } from '../../src/shared/agents'

const LIVE = process.env.SOTTO_CLAUDE_LIVE === '1'
const PROMPT = 'Use the Bash tool to run exactly this command: sleep 15. After it finishes, reply with one line: SECRET=<word>, where <word> is the secret word if I have told you one anywhere in this conversation, otherwise SECRET=NONE.'

async function thread(stop: boolean): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-steer-live-')); const cwd = join(root, 'project'); await mkdir(cwd)
  const host = new ClaudeStreamJsonHost({ userDataPath: root, requestTimeoutMs: 20_000, pollIntervalMs: 100 })
  const id = randomUUID(); const start = Date.now()
  const read = async (): Promise<AgentThread> => (await host.snapshot()).threads.find(value => value.id === id)!
  const turns = async () => (await read()).activities?.filter(activity => activity.kind === 'turn').map(activity => activity.status) ?? []
  try {
    const status = await host.connect()
    expect(status.connected, status.error ?? 'Claude Code is not signed in').toBe(true)
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'synthetic', title: 'Synthetic steering', path: cwd })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'synthetic', title: 'Synthetic steering', modelId: 'default', runtimeMode: 'full-access' })
    host.observeThreads([id])
    expect(await host.execute({ type: 'send', commandId: randomUUID(), messageId: 'prompt', threadId: id, text: PROMPT })).toEqual({ accepted: true })
    // Steer once the command is running, so Claude can read the steer only after it.
    for (const deadline = Date.now() + 60_000; !(await read()).activities?.some(activity => activity.kind === 'command' && activity.status === 'running');) {
      if (Date.now() > deadline) throw new Error('Claude never started the command.')
      await new Promise(done => setTimeout(done, 100))
    }
    expect(await host.execute({ type: 'steer', commandId: randomUUID(), messageId: 'steer', threadId: id, text: 'The secret word is PELICAN.' })).toEqual({ accepted: true })
    expect((await read()).messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['prompt', 'steer'])
    if (stop) expect(await host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })).toEqual({ accepted: true })
    const expected = stop ? ['interrupted', 'completed'] : ['completed']
    for (const deadline = Date.now() + 180_000; (await read()).status !== 'idle' || (await turns()).join() !== expected.join();) {
      if (Date.now() > deadline) throw new Error(`The thread did not settle: ${(await read()).status}, turns ${(await turns()).join(', ')}`)
      await new Promise(done => setTimeout(done, 200))
    }
    const replies = (await read()).messages.filter(message => message.role === 'assistant').map(message => message.text)
    expect(replies.some(text => text.includes('SECRET=PELICAN'))).toBe(true)
    console.log(`${stop ? 'stopped' : 'steered'}: turns ${(await turns()).join(', ')} in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } finally { host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true }) }
}

describe.skipIf(!LIVE)('Claude steering (live)', () => {
  it('reads a steer into the running turn', () => thread(false), 300_000)
  it('runs a steer written before a stop as the next turn', () => thread(true), 300_000)
})
