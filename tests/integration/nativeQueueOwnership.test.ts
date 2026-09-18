// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { FollowupStore } from '../../src/main/agents/followups'
import { codexFixture } from '../fixtures/codexFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

async function fixture() {
  const f = await codexFixture(undefined, true)
  await f.host.connect()
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, path: f.root, title: 'Synthetic' })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, modelId: f.modelId, title: 'Synthetic' })
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: text => text.toString() })
  await credentials.load()
  const create = () => new AgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  const control = create(); await control.start(); await control.command({ type: 'connect' })
  return { f, threadId, control, create }
}

it.each(['before idle', 'after idle'] as const)('waits for native completion when a follow-up is queued %s and the last turn is still running', async admission => {
  const { f, threadId, control } = await fixture()
  const pause = vi.spyOn(FollowupStore.prototype, 'pause')
  const claim = vi.spyOn(FollowupStore.prototype, 'claim')
  try {
    await control.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'First native turn' })
    const turnId = control.get().host.threads.find(t => t.id === threadId)!.lastTurn!.id
    const command = { type: 'queue-followup' as const, threadId, draftId: randomUUID(), text: 'After authoritative completion' }
    if (admission === 'before idle') await control.command(command)
    await f.action(threadId, { type: 'notify', method: 'thread/status/changed', params: { status: { type: 'idle' } } })
    await expect.poll(() => control.get().host.threads.find(t => t.id === threadId)?.status).toBe('idle')
    expect(control.get().host.threads.find(t => t.id === threadId)?.lastTurn).toEqual({ id: turnId, status: 'running' })
    if (admission === 'after idle') await control.command(command)
    expect(pause).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
    expect(control.get().followups).toEqual([expect.objectContaining({ draftId: command.draftId, status: 'queued' })])
    expect(JSON.parse(await readFile(join(f.root, 'followups.json'), 'utf8')).items).toEqual(control.get().followups)
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)

    await f.driver.completeTurn(threadId, 'Authoritative completion')
    await expect.poll(() => control.get().followups?.length).toBe(0)
    expect(claim).toHaveBeenCalledTimes(1)
    // Repeated delivery of the terminal event must not replay the follow-up.
    const observed = vi.fn(); const unsubscribe = f.host.subscribe(observed)
    try {
      await f.action(threadId, { type: 'notify', method: 'turn/completed', params: { turn: { id: turnId, status: 'completed', items: [] } } })
      await expect.poll(() => observed.mock.calls.length).toBeGreaterThan(0)
    } finally { unsubscribe() }
    await control.command({ type: 'refresh' })
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(2)
    expect(control.get().host.threads.find(t => t.id === threadId)?.messages.filter(m => m.role === 'user' && m.text === command.text)).toHaveLength(1)
  } finally {
    pause.mockRestore(); claim.mockRestore()
    control.dispose(); await control.privacyChanged(); await f.cleanup()
  }
})

it('clears the selected-skill draft after a process-backed native acceptance and restart', async () => {
  const { f, threadId, create, control } = await fixture()
  let restored: AgentControl | undefined
  try {
    const skill = { name: 'build', path: join(f.root, 'SKILL.md') }
    await f.script({ skills: [{ ...skill, enabled: true, scope: 'repo', description: 'Synthetic' }] })
    const draftId = randomUUID()
    const state = await control.command({ type: 'manual-send', threadId, draftId, text: '$build run', skills: [skill] })
    expect(state.error).toBeNull()
    expect((await f.driver.requests()).find(r => r.method === 'turn/start')?.params?.input).toEqual([{ type: 'text', text: '$build run' }, { type: 'skill', ...skill }])
    expect(state.deliveredDrafts).toContainEqual({ threadId, draftId })
    expect(state).toMatchObject({ draft: '', composing: false, threadDrafts: [] })
    control.dispose(); await control.privacyChanged()
    restored = create(); await restored.start(); await restored.command({ type: 'connect' })
    expect(restored.get()).toMatchObject({ draft: '', composing: false, threadDrafts: [] })
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))).toMatchObject({ draft: '', threadDrafts: [] })
  } finally { restored?.dispose(); control.dispose(); await (restored ?? control).privacyChanged(); await f.cleanup() }
})

it('does not start a second native turn when the same manual revision is queued during a delayed acknowledgement', async () => {
  const { f, threadId, control } = await fixture()
  try {
    await f.script({ delay: { method: 'turn/start', ms: 500 }, suppressNotifications: true })
    const command = { type: 'manual-send' as const, threadId, draftId: randomUUID(), text: 'Only once' }
    const sending = control.command(command)
    await expect.poll(async () => (await f.driver.requests()).filter(r => r.method === 'turn/start').length).toBe(1)
    const duplicate = control.command({ ...command, type: 'queue-followup' })
    await sending; await duplicate
    await f.script({}); await f.driver.completeTurn(threadId, 'Synthetic completion')
    await expect.poll(() => control.get().host.threads.find(t => t.id === threadId)?.messages.some(m => m.role === 'assistant' && m.text === 'Synthetic completion')).toBe(true)
    await expect.poll(() => control.get().followups?.length).toBe(0)
    await control.command({ type: 'refresh' })
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
    expect(control.get().host.threads.find(t => t.id === threadId)?.messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
  } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
})

it('keeps queued input out of native steering and sends it once after completion', async () => {
  const { f, threadId, control } = await fixture()
  try {
    await control.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'First turn' })
    const command = { type: 'queue-followup' as const, threadId, draftId: randomUUID(), text: 'Next turn' }
    await control.command(command)
    expect((await control.command({ ...command, type: 'steer' })).error).toBeNull()
    expect((await control.command({ ...command, type: 'manual-send' })).error).toBeNull()
    expect((await f.driver.requests()).filter(r => r.method === 'turn/steer')).toHaveLength(0)
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
    await f.driver.completeTurn(threadId, 'Synthetic completion')
    await expect.poll(() => control.get().followups?.length).toBe(0)
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(2)
    expect(control.get().host.threads.find(t => t.id === threadId)?.messages.filter(m => m.role === 'user' && m.text === command.text)).toHaveLength(1)
  } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
})

it.each(['failed', 'interrupted'] as const)('pauses for an authoritative %s outcome after native idle and requires explicit resume', async outcome => {
  const { f, threadId, control } = await fixture()
  try {
    await control.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'First native turn' })
    const command = { type: 'queue-followup' as const, threadId, draftId: randomUUID(), text: 'Requires review after terminal failure' }
    await control.command(command)
    await f.action(threadId, { type: 'notify', method: 'thread/status/changed', params: { status: { type: 'idle' } } })
    await expect.poll(() => control.get().host.threads.find(t => t.id === threadId)?.status).toBe('idle')
    await f.action(threadId, { type: 'complete', text: 'Terminal outcome', status: outcome })
    await expect.poll(() => control.get().followups?.[0]?.status).toBe('paused')
    expect(control.get().host.threads.find(t => t.id === threadId)?.lastTurn?.status).toBe(outcome)
    await control.command({ type: 'refresh' })
    expect(control.get().followups?.[0]?.status).toBe('paused')
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
    await control.command({ type: 'resume-followups', threadId })
    await expect.poll(() => control.get().followups?.length).toBe(0)
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(2)
  } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
})
