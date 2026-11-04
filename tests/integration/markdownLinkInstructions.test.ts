// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MARKDOWN_LINK_INSTRUCTIONS } from '../../src/main/agents/questionInstructions'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/** Each provider that takes Sotto's instructions is told to link a Markdown file it makes, only while the Owl answer is on (ADR-0120, November 3 amendment). */
describe.each([true, false])('a thread\'s instructions with the side panel %s', markdownLinks => {
  it('reach Claude Code', async () => {
    const f = await claudeFixture(undefined, 10_000, undefined, { markdownLinks }); cleanups.push(f.cleanup)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, title: 'Synthetic', modelId: f.modelId })
    const launch = (await f.driver.requests()).find(record => ['launch', 'resume'].includes(record.method ?? '') && (record.params!.frame as { args: string[] }).args.includes('--append-system-prompt'))!
    const { args } = launch.params!.frame as { args: string[] }
    expect(args[args.indexOf('--append-system-prompt') + 1]!.includes(MARKDOWN_LINK_INSTRUCTIONS)).toBe(markdownLinks)
  })

  it('reach Codex', async () => {
    const f = await codexFixture(undefined, false, 10_000, { markdownLinks }); cleanups.push(f.cleanup)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, title: 'Synthetic', modelId: f.modelId })
    const start = (await f.driver.requests()).find(record => record.method === 'thread/start')!
    expect(String(start.params!.developerInstructions).includes(MARKDOWN_LINK_INSTRUCTIONS)).toBe(markdownLinks)
  })

  it('reach Grok Build', async () => {
    const f = await grokFixture(undefined, 10_000, 60_000, {}, { markdownLinks }); cleanups.push(f.cleanup)
    await writeFile(join(f.root, 'script.json'), JSON.stringify({ catalog: { currentModelId: 'fixture-model', availableModels: ['fixture-model'].map(modelId => ({ modelId, name: modelId, _meta: { reasoningEffort: 'high', supportsReasoningEffort: true, reasoningEfforts: [{ id: 'high' }] } })) } }))
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, title: 'Synthetic', modelId: f.modelId })
    const start = (await f.driver.requests()).find(record => record.method === 'session/new' && (record.params!._meta as { rules?: string } | undefined)?.rules)!
    expect((start.params!._meta as { rules: string }).rules.includes(MARKDOWN_LINK_INSTRUCTIONS)).toBe(markdownLinks)
  })
})
