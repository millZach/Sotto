// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHost } from '../../src/main/agents/host'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { RecordedRpc } from '../fixtures/codexFixture'

export interface AdapterFixture {
  host: AgentHost; projectId: string; modelId: string; root: string
  driver: {
    typeInProvider(sessionId: string, text: string): Promise<void>
    completeTurn(sessionId: string, text: string): Promise<void>
    raiseQuestion(sessionId: string, text: string): Promise<void>
    raisePermission(sessionId: string, text: string): Promise<void>
    delayNextAck(method: string): Promise<void>
    requests(): Promise<RecordedRpc[]>
    restart(): Promise<AdapterFixture>
  }
  cleanup(): Promise<void>
  /** Decode recorded native traffic; fixtures must also reject invalid native replies. */
  protocol?: {
    promptMethod: string
    resumeMethod: string
    permissionDecision(record: RecordedRpc): boolean | undefined
  }
  /** A process-owned turn may stop when its adapter process exits. */
  restartStatus?: 'idle' | 'running'
  skips?: Partial<Record<'uncertain' | 'restart', string>>
}

/** New provider adapters must pass these behavioural checks with observable fake effects. */
export function describeAdapterContract(name: string, factory: () => Promise<AdapterFixture>): void {
  describe(`${name} thread interface contract`, () => {
    let f: AdapterFixture
    let sessionId: string
    const thread = async () => (await f.host.snapshot()).threads.find(t => t.id === sessionId)!
    const send = () => f.host.execute({ type: 'send', threadId: sessionId, commandId: randomUUID(), messageId: 'own-message', text: 'Synthetic prompt' })
    const permissionDecision = (record: RecordedRpc): boolean | undefined => {
      if (f.protocol) return f.protocol.permissionDecision(record)
      return record.result?.decision === 'accept' ? true : record.result?.decision === 'decline' ? false : undefined
    }
    beforeEach(async () => {
      f = await factory(); await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: sessionId, projectId: f.projectId, modelId: f.modelId, title: 'Contract thread' })
    })
    afterEach(async () => { await f?.cleanup() })
    it('observes provider takeover and rejects a reply based on stale user input', async () => {
      await send()
      await f.driver.typeInProvider(sessionId, 'Typed in the provider')
      await expect.poll(async () => (await thread()).messages.some(m => m.role === 'user' && m.text === 'Typed in the provider' && m.commandId === undefined)).toBe(true)
      await expect(f.host.execute({ type: 'send', threadId: sessionId, commandId: randomUUID(), messageId: 'stale-reply', text: 'Stale reply', expectedLastUserMessageId: 'own-message' })).rejects.toThrow('changed')
    })
    it('creates projects and threads, streams replies, and transitions running to idle', async () => {
      expect((await f.host.snapshot()).projects).toContainEqual({ id: f.projectId, title: 'Project', path: f.root })
      expect(await thread()).toMatchObject({ title: 'Contract thread', status: 'idle', modelId: f.modelId })
      const events: AgentHostSnapshot[] = []
      const unsubscribe = f.host.subscribe(s => events.push(s))
      expect(await send()).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status).toBe('running')
      expect((await thread()).messages).toContainEqual(expect.objectContaining({ id: 'own-message', role: 'user', commandId: expect.any(String) }))
      await f.driver.completeTurn(sessionId, 'Completed reply')
      await expect.poll(async () => (await thread()).status).toBe('idle')
      expect(events.some(s => s.threads.some(t => t.messages.some(m => m.text === 'Completed reply')))).toBe(true)
      unsubscribe()
    })
    it('cancels a running turn', async () => {
      await send()
      expect(await f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: sessionId })).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status).toBe('idle')
    })
    it('routes a question and delivers its answer', async () => {
      await send(); await f.driver.raiseQuestion(sessionId, 'Which color?')
      await expect.poll(async () => (await thread()).requests.length).toBe(1)
      const request = (await thread()).requests[0]!
      expect(request).toMatchObject({ kind: 'question', text: 'Which color?' })
      await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: sessionId, requestId: request.id, answer: 'Blue' })
      expect((await thread()).requests).toEqual([])
      await expect.poll(async () => JSON.stringify(await f.driver.requests())).toContain('Blue')
    })
    it.each([true, false])('delivers an explicit permission decision (%s)', async approved => {
      await send(); await f.driver.raisePermission(sessionId, 'Run build?')
      await expect.poll(async () => (await thread()).requests.length).toBe(1)
      const request = (await thread()).requests[0]!
      expect(request.kind).toBe('permission')
      await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: sessionId, requestId: request.id, answer: '', approved })
      await expect.poll(async () => (await f.driver.requests()).some(r => permissionDecision(r) === approved)).toBe(true)
      expect((await thread()).requests).toEqual([])
    })
    it('never approves a skipped permission when interrupted and disconnected', async () => {
      await send(); await f.driver.raisePermission(sessionId, 'Skipped permission')
      await expect.poll(async () => (await thread()).requests.length).toBe(1)
      await f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: sessionId })
      f.host.disconnect()
      expect((await f.driver.requests()).some(r => permissionDecision(r) === true)).toBe(false)
    })
    it('reconciles an uncertain prompt acknowledgement without resending', async context => {
      if (f.skips?.uncertain) { context.skip(); return }
      const method = f.protocol?.promptMethod ?? 'turn/start'
      await f.driver.delayNextAck(method)
      expect(await send()).toEqual({ accepted: false, uncertain: true })
      await expect.poll(async () => (await thread()).messages.filter(m => m.id === 'own-message').length).toBe(1)
      expect((await f.driver.requests()).filter(r => r.method === method)).toHaveLength(1)
    })
    it('resumes the same thread and messages after restart during a run', async context => {
      if (f.skips?.restart) { context.skip(); return }
      await send(); const before = await thread()
      f = await f.driver.restart(); f.host.observeThreads?.([sessionId]); await f.host.connect()
      // Some protocols restore transcript but cannot prove the previous turn outcome.
      // Optional live observation metadata must not be invented to satisfy replay equality.
      const beforeCore = { ...before }; delete beforeCore.lastTurn
      const restored = await thread(); delete restored.lastTurn
      expect(restored).toEqual({ ...beforeCore, status: f.restartStatus ?? before.status })
      expect((await f.driver.requests()).some(r => r.method === (f.protocol?.resumeMethod ?? 'thread/resume'))).toBe(true)
    })
  })
}
