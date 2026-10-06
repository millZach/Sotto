// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DevinAcpHost } from '../../src/main/agents/devin'

/**
 * Whether the installed Devin sends `agent_thought_chunk` updates, and that Sotto shows them as Thinking rows ahead of
 * the reply. Gated with the other Devin live checks: one short prompt, which is native account usage. Only counts are
 * reported; thinking text is reply content and never leaves the thread.
 */
it.skipIf(process.env['SOTTO_DEVIN_LIVE'] !== '1')('shows Devin’s thought chunks as Thinking rows before its reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-devin-live-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-devin-live-')) throw new Error('Unexpected temporary directory')
  const cwd = join(root, 'project'); const data = join(root, 'sotto')
  await mkdir(cwd); await mkdir(data)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true, stdio: 'ignore' })
  const host = new DevinAcpHost(data)
  const id = randomUUID()
  const model = process.env['SOTTO_DEVIN_THINKING_MODEL'] ?? 'swe-1-6-fast'
  const thread = async () => (await host.snapshot()).threads.find(thread => thread.id === id)!
  // Snapshots that showed a Thinking row while no reply text had arrived yet.
  const seen = { beforeReply: 0 }
  try {
    const connected = await host.connect()
    expect(connected.models.some(entry => entry.id === model && entry.ready)).toBe(true)
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Synthetic thinking check', path: cwd })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', title: 'Synthetic thinking check', modelId: model })
    host.observeThreads([id])
    const unsubscribe = host.subscribe(state => {
      const current = state.threads.find(entry => entry.id === id)
      if (current?.activities?.some(row => row.kind === 'reasoning') && !current.messages.some(message => message.role === 'assistant' && message.text)) seen.beforeReply++
    })
    const messageId = randomUUID()
    expect(await host.execute({ type: 'send', commandId: randomUUID(), messageId, threadId: id,
      text: 'Think it through before answering: what is 17 multiplied by 23? Reply with the number only. Do not use any tools.' })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).status, { timeout: 90_000 }).toBe('idle')
    unsubscribe()
    const rows = ((await thread()).activities ?? []).filter(row => row.kind === 'reasoning')
    // Counts only; run with --disable-console-intercept to see them.
    console.info('devin-thinking-live', { model, thinkingRows: rows.length, withText: rows.filter(row => row.text).length, snapshotsBeforeReply: seen.beforeReply })
    // The run is the evidence that Devin streams thought chunks, so it fails when none came, or none came before the reply.
    expect(rows.length).toBeGreaterThan(0)
    expect(seen.beforeReply).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).toMatchObject({ title: 'Thinking', turnId: messageId, afterMessageId: messageId })
      expect(['completed', 'interrupted']).toContain(row.status)
    }
  } finally {
    host.disconnect(); await host.closed()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
