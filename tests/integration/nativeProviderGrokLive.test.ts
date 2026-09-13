// @vitest-environment node
// Explicit opt-in: two synthetic user turns; provider-reported model-call counts saved as evidence.
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GrokAcpHost } from '../../src/main/agents/grok'
import { object } from '../../src/main/agents/claudeProtocol'

it.skipIf(process.env.SOTTO_PHASE3_GROK_LIVE !== '1')('Grok native requested effort confirmation uses no model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-phase3-grok-setup-')); const host = new GrokAcpHost(join(root, 'sotto')); const threadId = randomUUID()
  try {
    await host.connect(); await host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'Synthetic', path: root })
    expect(await host.execute({ type: 'create-thread', commandId: 't', threadId, projectId: 'p', title: 'Synthetic native setup', modelId: 'grok-4.6', reasoningEffort: 'low' })).toEqual({ accepted: true })
    expect((await host.snapshot()).threads[0]).toMatchObject({ modelId: 'grok-4.6', reasoningEffort: 'low', status: 'idle' })
  } finally { host.disconnect(); await host.closed() }
}, 30000)

it.skipIf(process.env.SOTTO_PHASE3_GROK_LIVE !== '1')('Grok native selected/manual expansion, command result and history reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-phase3-grok-adapter-')); const nonce = `EXPANDED_${randomUUID().replaceAll('-', '')}`
  const name = 'sotto-phase3-check'; const path = join(root, '.grok', 'skills', name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic adapter check.\n---\nIf the user's arguments contain no-tools, reply exactly ${nonce} without tools. Otherwise execute exactly echo SOTTO_GROK_TOOL_OK with the terminal tool once, then reply exactly ${nonce}. Do not read files or do other work.\n`)
  let host = new GrokAcpHost(join(root, 'sotto'), { pollIntervalMs: 100 }); const threadId = randomUUID()
  try {
    await host.connect(); await host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'Synthetic', path: root })
    expect(await host.execute({ type: 'create-thread', commandId: 't', threadId, projectId: 'p', title: 'Synthetic native probe', modelId: 'grok-4.6' })).toEqual({ accepted: true })
    const catalog = await host.listThreadSkills(threadId); const selected = catalog.skills.find(skill => skill.name === name)!
    expect(selected).toBeDefined()
    for (const [index, text] of [`$${name}`, `/${name} no-tools`].entries()) {
      expect(await host.execute({ type: 'send', commandId: `send-${index}`, messageId: `send-${index}`, threadId, text, ...(index === 0 ? { skills: [{ name: selected.name, path: selected.path }] } : {}) })).toEqual({ accepted: true })
      await expect.poll(async () => {
        const thread = (await host.snapshot()).threads[0]!
        for (const request of thread.requests) {
          const details = request.context?.details ? object(JSON.parse(request.context.details)) : undefined
          const allow = request.kind === 'permission' && details?.command === 'echo SOTTO_GROK_TOOL_OK'
          await host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: request.id, answer: '', approved: allow })
        }
        return thread.status
      }, { timeout: 90000, interval: 200 }).toBe('idle')
    }
    const before = (await host.snapshot()).threads[0]!
    const aliases = JSON.parse(await readFile(join(root, 'sotto', 'grok-threads.json'), 'utf8')); const nativeId = aliases[threadId].grokSessionId
    let history: unknown
    await host['rpc']!.request('_x.ai/session/updates', { sessionId: nativeId, cwd: root, offset: 0, limit: 1000 }, value => { history = value })
    host.disconnect(); await host.closed(); host = new GrokAcpHost(join(root, 'sotto')); await host.connect()
    const after = (await host.snapshot()).threads[0]!
    await writeFile(join(root, 'native-evidence.json'), JSON.stringify({ model: 'grok-4.6', submittedTurns: 2, before, after, history }, null, 2))
    expect(before.activities?.some(activity => activity.kind === 'command' && activity.status === 'completed' && activity.output?.includes('SOTTO_GROK_TOOL_OK'))).toBe(true)
    expect(before.messages.filter(message => message.role === 'assistant' && message.text.includes(nonce))).toHaveLength(2)
    expect(after.messages).toEqual(before.messages)
    expect(after.activities).toEqual(before.activities)
  } finally { host.disconnect(); await host.closed() }
}, 200000)
