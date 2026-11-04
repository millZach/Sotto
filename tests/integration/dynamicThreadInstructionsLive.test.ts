// @vitest-environment node
/**
 * The one thing the fakes cannot show for ADR-0191. A real Claude Code and a real Codex obey instructions given when a
 * provider session is created and ignore new ones on resume, so a thread that changes later is told by an overseer note
 * with its next message. This shows both halves: what resume ignores, and that the note reaches the model. Short turns on
 * the signed-in account on the cheapest model it lists, so it never runs in CI and runs only when asked:
 *
 *   SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/dynamicThreadInstructionsLive.test.ts --maxWorkers=1
 *   SOTTO_CODEX_LIVE=1 npx vitest run tests/integration/dynamicThreadInstructionsLive.test.ts --maxWorkers=1
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import type { AgentHost } from '../../src/main/agents/host'
import type { AgentHostSnapshot, AgentModel } from '../../src/shared/agents'

async function notedTurns(make: (directory: string) => AgentHost & { threadInstructionsChanged(id: string): Promise<void>; useWorkerRoles?: AgentHost['useWorkerRoles'] }, pick: (model: AgentModel) => boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-dynamic-live-'))
  const host = make(directory)
  // Nothing in the conversation can answer these questions, so only what the session was told can.
  let note: string | undefined
  host.useWorkerRoles!({ table: () => [], onChange: () => () => undefined, overseerNote: () => note })
  try {
    const connected = await host.connect()
    const model = connected.models.find(item => item.ready && pick(item)) ?? connected.models.find(item => item.ready)
    expect(model, 'a ready model').toBeDefined()
    const threadId = randomUUID()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'probe', title: 'Dynamic probe', path: directory })
    expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), projectId: 'probe', threadId, title: 'Synthetic Dynamic probe', modelId: model!.id, runtimeMode: 'approval-required' })).toMatchObject({ accepted: true })
    const lastReply = async (): Promise<string | undefined> => {
      const snapshot: AgentHostSnapshot = await host.snapshot()
      const thread = snapshot.threads.find(item => item.id === threadId)
      if (thread?.status === 'running') return undefined
      return thread?.messages.findLast(message => message.role === 'assistant')?.text
    }
    const noTools = 'Answer from what you already know, without using any tools or reading any files.'
    const turn = async (text: string, word: string, overseerNote?: string) => {
      expect(await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: `${noTools} ${text}`, ...overseerNote ? { overseerNote } : {} })).toMatchObject({ accepted: true })
      await expect.poll(async () => (await lastReply())?.toLowerCase(), { timeout: 120_000, interval: 2_000 }).toContain(word.toLowerCase())
    }
    await turn('What is 2 + 2? Reply with the number alone.', '4')
    // Turned on at rest: the process goes, and the next message carries the note.
    note = 'This project has a mascot, a heron called PERIWINKLE. Answer questions about it from this note.'
    await host.threadInstructionsChanged(threadId)
    await turn('What is this project\'s mascot called? Reply with its name alone.', 'PERIWINKLE', note)
    // A later note reaches the same session, about something it has not been told.
    note = 'This project\'s server is in the city of OSLO. Answer questions about it from this note.'
    await host.threadInstructionsChanged(threadId)
    await turn('Which city is this project\'s server in? Reply with the city alone.', 'OSLO', note)
  } finally {
    host.disconnect()
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
}

describe('requires SOTTO_CLAUDE_LIVE=1 or SOTTO_CODEX_LIVE=1', () => {
  it.skipIf(process.env.SOTTO_CLAUDE_LIVE !== '1')('Claude Code obeys an overseer note on a session that has already started', async () => {
    await notedTurns(directory => new ClaudeStreamJsonHost({ userDataPath: directory }) as never, model => /haiku/iu.test(model.id))
  }, 420_000)
  it.skipIf(process.env.SOTTO_CODEX_LIVE !== '1')('Codex obeys an overseer note on a thread that has already started', async () => {
    await notedTurns(directory => new CodexAppServerHost({ userDataPath: directory }) as never, model => /luna/iu.test(model.id))
  }, 420_000)
})
