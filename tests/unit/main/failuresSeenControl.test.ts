// @vitest-environment node
/**
 * The coordinator keeps which failed threads have been seen (ADR-0092): seen when any client shows the thread or Dismiss
 * all names it, published on the shell every client reads, dropped by the thread's next turn, and saved so a restart
 * keeps it. A thread waiting on a request is never seen this way.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { LocalHostService } from '../../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentState } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) control.dispose()
  controls.clear()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-failures-seen-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function start(root?: string, prepare?: (host: E2EAgentHost) => void) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'sotto-failures-seen-'))
  if (root === undefined) roots.push(directory)
  const host = new E2EAgentHost()
  prepare?.(host)
  const credentials = await testCredentials(directory, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory, host, credentials, reasoner: e2eAgentReasoner })
  controls.add(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  const service = new LocalHostService({ control })
  return { root: directory, host, control, service }
}
const phones = { clientId: 'socket-observations', user: '', transport: 'socket' as const }
const seen = (state: AgentState, id: string): boolean | undefined => state.host.threads.find(thread => thread.id === id)?.failureSeen
/** What the window names for Dismiss all: each thread with the failure the host published for it. */
const named = (control: AgentControl, ...ids: string[]) => ids.map(threadId => ({ threadId, failure: control.shell().host.threads.find(thread => thread.id === threadId)?.failureId ?? '' }))
/** A turn on the fixture thread that fails: the prompt starts it running, the failure leaves it in error. */
function failTurn(host: E2EAgentHost, threadId: string): void {
  host.event({ type: 'manual', threadId, text: 'Synthetic prompt' })
  host.event({ type: 'failure', threadId, text: 'Synthetic failure' })
}

describe('the coordinator\'s record of failures seen', () => {
  it('sees a failed thread when a client shows it, on the shell and the whole state', async () => {
    const { host, control, service } = await start()
    failTurn(host, 'workshop')
    expect(seen(control.shell(), 'workshop')).toBeUndefined()
    const published: AgentState[] = []
    control.subscribe(state => published.push(state))
    const reply = await service.command({ type: 'observe-threads', threadIds: ['workshop'] }, phones)
    expect(seen(reply, 'workshop')).toBe(true)
    expect(seen(control.get(), 'workshop')).toBe(true)
    // Every other client hears of it without waiting for the thread to change.
    expect(seen(published.at(-1)!, 'workshop')).toBe(true)
  })

  it('stamps when a request started waiting and when a failure was named, on the shell and the whole state (ADR-0135)', async () => {
    const { host, control } = await start()
    host.event({ type: 'permission', threadId: 'workshop', text: 'Run the build?' })
    failTurn(host, 'docs')
    const request = control.shell().host.threads.find(thread => thread.id === 'workshop')!.requests[0]!
    expect(request.since).toBeDefined()
    expect(Number.isFinite(Date.parse(request.since!))).toBe(true)
    // The stamp is the one fact however a client reads the thread, and it does not move while the request stands.
    expect(control.get().host.threads.find(thread => thread.id === 'workshop')!.requests[0]?.since).toBe(request.since)
    expect(control.shell().host.threads.find(thread => thread.id === 'workshop')!.requests[0]?.since).toBe(request.since)
    const failed = control.shell().host.threads.find(thread => thread.id === 'docs')!
    expect(failed.failureId).toBeDefined()
    expect(failed.failureSince).toBeDefined()
    expect(Number.isFinite(Date.parse(failed.failureSince!))).toBe(true)
  })

  it('sees a thread that fails while a client shows it', async () => {
    const { host, control, service } = await start()
    await service.command({ type: 'observe-threads', threadIds: ['workshop'] }, phones)
    failTurn(host, 'workshop')
    expect(seen(control.shell(), 'workshop')).toBe(true)
  })

  it('counts the window\'s panes only while it has the focus', async () => {
    const { host, control, service } = await start()
    service.setWindowFocused(false)
    await service.command({ type: 'observe-threads', threadIds: ['workshop'] }, { clientId: 'desktop-window', user: '', transport: 'ipc' })
    failTurn(host, 'workshop')
    expect(seen(control.shell(), 'workshop')).toBeUndefined()
    service.setWindowFocused(true)
    expect(seen(control.shell(), 'workshop')).toBe(true)
  })

  it('sees every failed thread Dismiss all names and leaves the rest', async () => {
    const { host, control, service } = await start()
    failTurn(host, 'workshop'); failTurn(host, 'docs')
    const reply = await service.command({ type: 'dismiss-failures', failures: named(control, 'workshop') }, phones)
    expect(reply.error).toBeNull()
    expect(seen(reply, 'workshop')).toBe(true)
    expect(seen(control.shell(), 'docs')).toBeUndefined()
  })

  it('never dismisses a thread that waits on a permission or a question', async () => {
    const { host, control, service } = await start()
    host.event({ type: 'manual', threadId: 'workshop', text: 'Synthetic prompt' })
    host.event({ type: 'permission', threadId: 'workshop', text: 'Run the build?', status: 'error' })
    host.event({ type: 'question', threadId: 'docs', text: 'Which branch?', status: 'error' })
    await service.command({ type: 'dismiss-failures', failures: named(control, 'workshop', 'docs') }, phones)
    await service.command({ type: 'observe-threads', threadIds: ['workshop', 'docs'] }, phones)
    expect(seen(control.shell(), 'workshop')).toBeUndefined()
    expect(seen(control.shell(), 'docs')).toBeUndefined()
    expect(control.shell().host.threads.find(thread => thread.id === 'workshop')!.requests).toHaveLength(1)
  })

  it('makes the next failure news again once the thread works again', async () => {
    const { host, control, service } = await start()
    failTurn(host, 'workshop')
    await service.command({ type: 'dismiss-failures', failures: named(control, 'workshop') }, phones)
    expect(seen(control.shell(), 'workshop')).toBe(true)
    host.event({ type: 'manual', threadId: 'workshop', text: 'Try again' })
    expect(seen(control.shell(), 'workshop')).toBeUndefined()
    host.event({ type: 'failure', threadId: 'workshop', text: 'Failed again' })
    expect(seen(control.shell(), 'workshop')).toBeUndefined()
  })

  it('leaves a failure that came after the press as news', async () => {
    const { host, control, service } = await start()
    failTurn(host, 'workshop')
    const pressed = named(control, 'workshop')
    expect(pressed[0]!.failure).not.toBe('')
    // The thread's next turn fails before Dismiss all reaches the host.
    failTurn(host, 'workshop')
    const reply = await service.command({ type: 'dismiss-failures', failures: pressed }, phones)
    expect(reply.error).toBeNull()
    expect(seen(control.shell(), 'workshop')).toBeUndefined()
  })

  it('saves a failure seen while the host is disconnected, without waiting for it to connect again', async () => {
    const { root, host, control, service } = await start()
    await service.command({ type: 'observe-threads', threadIds: ['workshop'] }, phones)
    const saved = async () => {
      try { return (JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')) as { failuresSeen?: { threadId: string }[] }).failuresSeen?.map(mark => mark.threadId) }
      catch { return undefined }
    }
    host.event({ type: 'manual', threadId: 'workshop', text: 'Synthetic prompt' })
    host.event({ type: 'disconnect', threadId: 'workshop', text: '' })
    // What the connected snapshots before it queued is written first, so only the disconnected one can save the mark.
    await expect.poll(saved).toEqual([])
    // A reconnect would save it in a few seconds anyway; the snapshot that saw it saves it now.
    const persist = vi.spyOn(control as unknown as { persist: () => Promise<void> }, 'persist')
    host.event({ type: 'failure', threadId: 'workshop', text: 'Synthetic failure' })
    expect(control.shell().host.connected).toBe(false)
    expect(seen(control.shell(), 'workshop')).toBe(true)
    await Promise.resolve()
    expect(persist).toHaveBeenCalled()
    await expect.poll(saved).toEqual(['workshop'])
  })

  it('keeps a seen failure across a restart', async () => {
    const first = await start()
    failTurn(first.host, 'workshop'); failTurn(first.host, 'docs')
    await first.service.command({ type: 'dismiss-failures', failures: named(first.control, 'workshop') }, phones)
    await first.control.closed()
    first.control.dispose(); controls.delete(first.control)
    // The thread ID, the host's name for its failure and when it was named: nothing the thread said is saved with the mark.
    const saved = JSON.parse(await readFile(join(first.root, 'agents.json'), 'utf8')) as { failuresSeen: unknown }
    expect(saved.failuresSeen).toEqual([{ threadId: 'workshop', failure: expect.any(String), since: expect.any(Number) }])
    // The provider reports both threads failed again when Sotto starts.
    const second = await start(first.root, host => {
      host.event({ type: 'failure', threadId: 'workshop', text: 'Synthetic failure' })
      host.event({ type: 'failure', threadId: 'docs', text: 'Synthetic failure' })
    })
    expect(seen(second.control.shell(), 'workshop')).toBe(true)
    expect(seen(second.control.shell(), 'docs')).toBeUndefined()
  })
})
