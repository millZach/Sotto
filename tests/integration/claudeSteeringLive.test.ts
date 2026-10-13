// @vitest-environment node
/**
 * Opt-in live check that a Claude thread steers (ADR-0065, ADR-0075). It makes a synthetic project in a temporary
 * folder and runs threads against the installed, signed-in Claude Code, with bypassing allowed so the command needs no
 * answer. Each asks Claude for work, then to say the secret word if it was told one, and a steer tells it PELICAN.
 * Steered while Claude thinks or writes a long reply, the reply is cut and the steer answered as the next turn; steered
 * while a command runs, the command finishes and the same turn reads the steer; written before a stop, the steer runs as
 * the next turn, and the stop still ends the command. It prints which turns the thread recorded and how long each case
 * took; no message text is printed.
 *
 * Claude Code 2.1.296 refuses a bare `sleep`, so the command waits on a Node timer.
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
const SECRET = 'reply with one line: SECRET=<word>, where <word> is the secret word if I have told you one anywhere in this conversation, otherwise SECRET=NONE.'
const COMMAND = `Use the Bash tool to run exactly this command, which waits 15 seconds: node -e "setTimeout(() => {}, 15000)". After it finishes, ${SECRET}`
const ESSAY = `Write a 2000-word essay on the history of the lighthouse. Use no tools. At the very end, ${SECRET}`

type Case = 'mid-reply' | 'command' | 'stop'

async function thread(which: Case): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-steer-live-')); const cwd = join(root, 'project'); await mkdir(cwd)
  const host = new ClaudeStreamJsonHost({ userDataPath: root, requestTimeoutMs: 20_000, pollIntervalMs: 100 })
  const id = randomUUID(); const start = Date.now()
  const read = async (): Promise<AgentThread> => (await host.snapshot()).threads.find(value => value.id === id)!
  const records = async () => (await read()).activities?.filter(activity => activity.kind === 'turn') ?? []
  const turns = async () => (await records()).map(activity => activity.status)
  const until = async (ready: (thread: AgentThread) => boolean, failure: string): Promise<void> => {
    for (const deadline = Date.now() + 120_000; !ready(await read());) {
      if (Date.now() > deadline) throw new Error(failure)
      await new Promise(done => setTimeout(done, 100))
    }
  }
  try {
    const status = await host.connect()
    expect(status.connected, status.error ?? 'Claude Code is not signed in').toBe(true)
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'synthetic', title: 'Synthetic steering', path: cwd })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'synthetic', title: 'Synthetic steering', modelId: 'default', runtimeMode: 'full-access' })
    host.observeThreads([id])
    expect(await host.execute({ type: 'send', commandId: randomUUID(), messageId: 'prompt', threadId: id, text: which === 'mid-reply' ? ESSAY : COMMAND })).toEqual({ accepted: true })
    // Steer once Claude is thinking or writing its reply, or once the command is running, so Claude could read it only
    // after. The command's row shows from the call's first byte and names the command once Claude has written it all.
    if (which === 'mid-reply') {
      await until(value => value.activities?.some(activity => activity.kind === 'reasoning') === true
        || value.messages.some(message => message.role === 'assistant' && message.text.length > 0), 'Claude never started its reply.')
    } else {
      await until(value => value.activities?.some(activity => activity.kind === 'command' && activity.status === 'running' && activity.command?.includes('setTimeout') === true) === true,
        'Claude never started the command.')
    }
    const steered = Date.now()
    const text = which === 'mid-reply' ? 'Stop the essay here. The secret word is PELICAN. Reply now with only the SECRET line.' : 'The secret word is PELICAN.'
    expect(await host.execute({ type: 'steer', commandId: randomUUID(), messageId: 'steer', threadId: id, text })).toEqual({ accepted: true })
    expect((await read()).messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['prompt', 'steer'])
    if (which === 'stop') expect(await host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })).toEqual({ accepted: true })
    await until(value => value.status === 'idle' && value.activities?.filter(activity => activity.kind === 'turn').every(activity => activity.status !== 'running') === true,
      'The thread did not settle.')
    // A steer cuts a reply and runs next; one that waited on a command is read into the same turn; a stop is the user's own.
    expect(await turns()).toEqual(which === 'command' ? ['completed'] : ['interrupted', 'completed'])
    expect((await records()).map(record => record.steered === true)).toEqual(which === 'mid-reply' ? [true, false] : which === 'command' ? [false] : [false, false])
    const replies = (await read()).messages.filter(message => message.role === 'assistant').map(message => message.text)
    expect(replies.some(text => text.includes('SECRET=PELICAN'))).toBe(true)
    console.log(`${which}: turns ${(await turns()).join(', ')} in ${((Date.now() - start) / 1000).toFixed(1)}s, ${((Date.now() - steered) / 1000).toFixed(1)}s after the steer`)
  } finally { host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true }) }
}

describe.skipIf(!LIVE)('Claude steering (live) (requires SOTTO_CLAUDE_LIVE=1)', () => {
  it('cuts a long reply for a steer and answers the steer next', () => thread('mid-reply'), 300_000)
  it('lets a running command finish, then reads the steer into the same turn', () => thread('command'), 300_000)
  it('runs a steer written before a stop as the next turn', () => thread('stop'), 300_000)
})
