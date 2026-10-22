// @vitest-environment node
/**
 * The coordinator keeps the prototype-ready mark (ADR-0108): earned when a thread's ended turn names a page that opens,
 * published on the shell every client reads, cleared by opening one of its pages through any client or by replying,
 * and saved so a restart does not bring it back.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-prototype-ready-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function start(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'sotto-prototype-ready-'))
  if (root === undefined) roots.push(directory)
  const host = new E2EAgentHost()
  await host.initializeWorkingFolders(directory)
  await writeFile(join(directory, 'project', 'greeting-prototype.html'), '<h1>Greeting</h1>')
  const credentials = await testCredentials(directory, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory, host, credentials, reasoner: e2eAgentReasoner })
  controls.add(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  return { root: directory, host, control, service: new LocalHostService({ control }) }
}
const mark = (state: AgentState, id = 'workshop') => state.host.threads.find(thread => thread.id === id)?.prototypeReady
function finishWithPrototype(host: E2EAgentHost): void {
  host.event({ type: 'manual', threadId: 'workshop', text: 'Make a prototype' })
  host.event({ type: 'ready', threadId: 'workshop', text: 'The prototype is at greeting-prototype.html.' })
}

describe('the coordinator’s prototype-ready mark', () => {
  it('marks a thread whose finished reply names a working page, on the shell and the whole state, with a token the page route serves', async () => {
    const { host, control } = await start()
    finishWithPrototype(host)
    await vi.waitFor(() => expect(mark(control.shell())).toBeDefined())
    const ready = mark(control.shell())!
    expect(ready.source).toMatch(/^reply:/u)
    expect(ready.pages).toEqual([{ token: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u), kind: 'file', name: 'greeting-prototype.html', start: 'greeting-prototype.html' }])
    expect(mark(control.get())).toEqual(ready)
    expect(control.questionPage(ready.pages[0]!.token)).toMatchObject({ kind: 'file' })
    expect(mark(control.shell(), 'docs')).toBeUndefined()
  })

  it('clears the mark when one of its pages is opened through the host service, and a restart keeps it cleared', async () => {
    const { root, host, control, service } = await start()
    finishWithPrototype(host)
    await vi.waitFor(() => expect(mark(control.shell())).toBeDefined())
    service.questionPageOpened(mark(control.shell())!.pages[0]!.token)
    expect(mark(control.shell())).toBeUndefined()
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).prototypesCleared).toHaveLength(1))
    // When marks began is saved with them, and a restart keeps the first start's, so older replies stay unmarked.
    const began = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).prototypesSince as number
    expect(began).toEqual(expect.any(Number))
    control.dispose(); controls.delete(control)
    const again = await start(root)
    again.host.event({ type: 'manual', threadId: 'docs', text: 'Note', status: 'idle' })
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).prototypesSince).toBe(began))
    // The restarted fixture host has the same reply again, under the same message ID it had: nothing marks it.
    again.host.event({ type: 'history', threadId: 'workshop', text: '', messages: control.get().host.threads.find(thread => thread.id === 'workshop')!.messages })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(mark(again.control.shell())).toBeUndefined()
  })

  it('keeps the mark while the thread runs on and after a newer reply that names no page, and a restart keeps it', async () => {
    const { root, host, control } = await start()
    finishWithPrototype(host)
    await vi.waitFor(() => expect(mark(control.shell())).toBeDefined())
    const source = mark(control.shell())!.source
    host.event({ type: 'stream', threadId: 'workshop', messageId: 'working', text: 'Checking the footer', status: 'running' })
    expect(control.shell().host.threads.find(thread => thread.id === 'workshop')!.status).toBe('running')
    expect(mark(control.shell())?.source).toBe(source)
    host.event({ type: 'ready', threadId: 'workshop', text: 'Done.' })
    expect(mark(control.shell())?.source).toBe(source)
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).prototypesMarked)
      .toEqual([{ threadId: 'workshop', messageId: source.slice('reply:'.length), createdAt: expect.any(String) }]))
    const messages = control.get().host.threads.find(thread => thread.id === 'workshop')!.messages
    control.dispose(); controls.delete(control)
    const again = await start(root)
    again.host.event({ type: 'history', threadId: 'workshop', text: '', messages })
    await vi.waitFor(() => expect(mark(again.control.shell())?.source).toBe(source))
  })

  it('clears the mark when the user replies, and showing the thread does not', async () => {
    const { host, control } = await start()
    finishWithPrototype(host)
    await vi.waitFor(() => expect(mark(control.shell())).toBeDefined())
    control.showThreads(['workshop'])
    expect(mark(control.shell())).toBeDefined()
    host.event({ type: 'manual', threadId: 'workshop', text: 'Thanks', status: 'idle' })
    expect(mark(control.shell())).toBeUndefined()
  })
})
