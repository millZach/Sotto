// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterSessionOptions, HostServiceFixture, RecordedRpc } from '../fixtures/adapterFixture'

export function describeHostServiceContract(name: string, factory: (session?: AdapterSessionOptions) => Promise<HostServiceFixture>): void {
  describe(name + ' host service contract', () => {
    let f: HostServiceFixture
    let threadId: string
    let projectId: string
    const client = { clientId: 'desktop-window', user: 'host-contract', transport: 'ipc' } as const
    const command = async (value: import('../../src/shared/agents').AgentCommand) => f.service.command(value, client)
    const thread = (id = threadId) => f.service.state().host.threads.find(item => item.id === id)!
    const send = (text = 'Synthetic prompt', id = threadId) => command({ type: 'manual-send', threadId: id, text })
    const create = async (title: string): Promise<string> => {
      const id = randomUUID()
      const state = await command({ type: 'create-thread', threadId: id, projectId, title, modelId: f.modelId, workingCopy: 'shared', managed: false })
      expect(state.error).toBeNull()
      return id
    }
    const permissionDecision = (record: RecordedRpc): boolean | undefined => f.protocol
      ? f.protocol.permissionDecision(record)
      : record.result?.decision === 'accept' ? true : record.result?.decision === 'decline' ? false : undefined
    beforeEach(async () => {
      f = await factory({ reaperSweepMs: 20, sessionIdleMs: 150 })
      expect((await command({ type: 'connect', provider: f.provider })).error).toBeNull()
      const state = await command({ type: 'create-project', provider: f.provider, title: 'Contract project', path: f.root, useExisting: true })
      expect(state.error).toBeNull()
      projectId = state.host.projects.find(project => project.path === f.root)!.id
      threadId = await create('Contract thread')
      await command({ type: 'observe-threads', threadIds: [threadId] })
    })
    afterEach(async () => { await f?.cleanup() })

    it('creates and streams through Sotto identities and exposes the event history', async () => {
      expect(await f.nativeStarted(threadId)).toBe(false)
      expect((await send()).error).toBeNull()
      expect(thread().status).toBe('running')
      await f.driver.completeTurn(threadId, 'Completed reply')
      await expect.poll(() => thread().status).toBe('idle')
      await expect.poll(() => f.service.threadDetail(threadId)?.messages.some(message => message.text.includes('Completed reply'))).toBe(true)
      expect(f.service.events(0, threadId).some(event => event.event.kind === 'message-added')).toBe(true)
      expect(f.service.shell().host.threads.every(item => item.messages.length === 0)).toBe(true)
    })

    it('observes provider takeover without inventing a Sotto command for native user input', async () => {
      await send()
      await f.driver.typeInProvider(threadId, 'Typed in the provider')
      await expect.poll(() => thread().messages.some(message => message.role === 'user' && message.text === 'Typed in the provider' && message.commandId === undefined)).toBe(true)
    })

    it('delivers a question answer', async () => {
      await send(); await f.driver.raiseQuestion(threadId, 'Which color?')
      await expect.poll(() => thread().requests.length).toBe(1)
      const request = thread().requests[0]!
      expect(request.kind).toBe('question')
      expect((await command({ type: 'answer', threadId, requestId: request.id, answer: 'Blue' })).error).toBeNull()
      await expect.poll(async () => JSON.stringify(await f.driver.requests())).toContain('Blue')
      expect(thread().requests).toEqual([])
    })

    it.each([true, false])('records an explicit permission answer (%s) with the client identity', async approved => {
      await send(); await f.driver.raisePermission(threadId, 'Run build?')
      await expect.poll(() => thread().requests.length).toBe(1)
      const request = thread().requests[0]!
      expect((await command({ type: 'answer', threadId, requestId: request.id, answer: '', approved })).error).toBeNull()
      await expect.poll(async () => (await f.driver.requests()).some(record => permissionDecision(record) === approved)).toBe(true)
      expect(f.service.events(0, threadId)).toContainEqual(expect.objectContaining({
        event: expect.objectContaining({ kind: 'answer-given', approved, attribution: f.client ?? client }),
      }))
    })

    it('cancels without approving a skipped permission', async () => {
      await send(); await f.driver.raisePermission(threadId, 'Skipped permission')
      await expect.poll(() => thread().requests.length).toBe(1)
      await command({ type: 'interrupt', threadId })
      await command({ type: 'disconnect', provider: f.provider })
      expect((await f.driver.requests()).some(record => permissionDecision(record) === true)).toBe(false)
    })

    it('reconciles a lost prompt acknowledgement without resending', async context => {
      if (f.skips?.uncertain) { context.skip(); return }
      const method = f.protocol?.promptMethod ?? 'turn/start'
      await f.driver.delayNextAck(method)
      await send()
      await expect.poll(() => thread().messages.filter(message => message.role === 'user' && message.text === 'Synthetic prompt').length).toBe(1)
      expect((await f.driver.requests()).filter(record => record.method === method)).toHaveLength(1)
    })

    it('keeps the same thread and saved messages across host restart during a run', async context => {
      if (f.skips?.restart) { context.skip(); return }
      await send()
      const before = thread().messages
      const identity = f.service.state().hostId
      f = await f.driver.restart()
      await command({ type: 'observe-threads', threadIds: [threadId] })
      await command({ type: 'connect', provider: f.provider })
      await expect.poll(() => thread().messages).toEqual(before)
      expect(f.service.state().hostId).toBe(identity)
      expect(thread().id).toBe(threadId)
    })

    it('reaps an unwatched idle session beside a running one and resumes it on send with its history', async context => {
      if (!f.sessions || f.skips?.lazy) { context.skip(); return }
      await send()
      await expect.poll(() => thread().status).toBe('running')
      const runningStarts = await f.sessions.starts(threadId)
      const quiet = await create('Quiet thread')
      await send('Quiet prompt', quiet)
      await f.driver.completeTurn(quiet, 'Quiet reply')
      await expect.poll(() => thread(quiet).status).toBe('idle')
      await command({ type: 'select-thread', threadId })
      await command({ type: 'observe-threads', threadIds: [threadId] })
      const starts = await f.sessions.starts(quiet)
      await expect.poll(() => f.sessions!.stopped(quiet)).toBe(true)
      expect(thread().status).toBe('running')
      expect(await f.sessions.starts(threadId)).toBe(runningStarts)
      expect(f.service.events(0, quiet).some(event => event.event.kind === 'message-added')).toBe(true)
      expect((await send('After reaping', quiet)).error).toBeNull()
      await expect.poll(() => f.sessions!.starts(quiet)).toBeGreaterThan(starts)
      await command({ type: 'select-thread', threadId: quiet })
      await command({ type: 'observe-threads', threadIds: [quiet] })
      await expect.poll(() => f.service.threadDetail(quiet)?.messages.some(message => message.text === 'Quiet prompt')).toBe(true)
    })
  })
}
