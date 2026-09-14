// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'

for (const provider of ['codex', 'claude'] as const) it.runIf(process.env.SOTTO_PHASE5_COMPACTION_NATIVE === '1')(`installed ${provider} native manual compaction on one owned synthetic thread`, async () => {
  const root = await mkdtemp(join(tmpdir(), `sotto-phase5-${provider}-compact-`))
  const host = provider === 'codex' ? new CodexAppServerHost({ userDataPath: root }) : new ClaudeStreamJsonHost({ userDataPath: root })
  const evidence: Record<string, unknown> = { root, provider, checkedAt: new Date().toISOString(), syntheticTurns: 1 }
  try {
    const connected = await host.connect()
    expect(connected.connected, connected.error).toBe(true)
    evidence.version = connected.version
    await host.execute({ type: 'create-project', commandId: 'project', projectId: 'owned', title: 'Owned synthetic compaction', path: root })
    await host.execute({ type: 'create-thread', commandId: 'create', threadId: 'owned', projectId: 'owned', title: 'Synthetic compaction check',
      modelId: provider === 'codex' ? 'gpt-6-astra' : 'default', ...(provider === 'codex' ? { reasoningEffort: 'low', runtimeMode: 'approval-required' as const } : {}) })
    await host.execute({ type: 'send', commandId: 'prompt', messageId: 'prompt', threadId: 'owned', text: 'Synthetic Sotto native compaction check. Reply exactly SOTTO_COMPACTION_OK. Do not use tools, read files, browse, delegate, or change anything.' })
    await expect.poll(async () => (await host.snapshot()).threads[0]?.status, { timeout: 60000, interval: 250 }).toBe('idle')
    evidence.before = (await host.snapshot()).threads[0]
    evidence.acceptance = await host.execute({ type: 'compact-thread', commandId: 'compact', threadId: 'owned' })
    await expect.poll(async () => (await host.snapshot()).threads[0]?.compaction?.status, { timeout: 60000, interval: 250 }).toMatch(/completed|failed/)
    evidence.after = (await host.snapshot()).threads[0]
    expect((await host.snapshot()).threads[0]?.compaction?.status).toBe('completed')
    // Control echoes and summaries must never look like user takeover or future prompts.
    expect((await host.snapshot()).threads[0]?.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['prompt'])
    await expect.poll(async () => (await host.snapshot()).threads[0]?.status, { timeout: 10000, interval: 100 }).toBe('idle')
    evidence.after = (await host.snapshot()).threads[0]
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); evidence.after = (await host.snapshot().catch(() => undefined))?.threads[0]; throw error }
  finally {
    host.disconnect(); await host.closed()
    await mkdir('artifacts/phase-five-compaction', { recursive: true })
    await writeFile(`artifacts/phase-five-compaction/${provider}-native.json`, JSON.stringify(evidence, null, 2))
  }
}, 160000)
