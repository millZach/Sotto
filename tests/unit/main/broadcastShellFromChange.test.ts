// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentMessage, AgentState, AgentThread } from '../../../src/shared/agents'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * The shell a broadcast carries is prepared from what changed since the last one (#1334): the part that is not threads is
 * copied only when something in it changed, and a thread whose record and marks have not changed is carried as the record
 * the last broadcast carried. Every broadcast still holds exactly what `shell()` would give.
 */
const copies = vi.hoisted(() => ({ plain: 0 }))
vi.mock('../../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/main/agents/cloneHostSnapshot')>()
  return { ...original, clonePlainData: <T>(value: T): T => { copies.plain++; return original.clonePlainData(value) } }
})

type Internals = Pick<AgentControl, 'broadcastShell' | 'shell'> & { state: AgentState; finishedUnread: { restore(saved: readonly string[]): void } }
const controls: AgentControl[] = [], roots: string[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-broadcast-shell-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

const at = '2026-10-23T00:00:00.000Z'
const message = (id: string, text: string): AgentMessage => ({ id, role: 'assistant', text, createdAt: at })
const thread = (id: string, extra: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Synthetic ${id}`, modelId: 'fake', status: 'idle',
  messages: [message(`${id}-reply`, 'Synthetic reply')], requests: [], activities: [], ...extra })

function fixture(): Internals {
  const directory = mkdtempSync(join(tmpdir(), 'sotto-broadcast-shell-')); roots.push(directory)
  const created = createAgentControl({ directory, host: new E2EAgentHost(), credentials: { has: () => false, available: () => false } as never })
  controls.push(created)
  const control = created as unknown as Internals
  control.state.host = { ...control.state.host, connected: true, projects: [{ id: 'project', title: 'Synthetic', path: join(directory, 'project') }],
    threads: [thread('one'), thread('two')] }
  return control
}

describe('the shell a broadcast carries', () => {
  it('copies what is not threads only when something in it changed', () => {
    const control = fixture()
    const first = control.broadcastShell()
    copies.plain = 0
    const second = control.broadcastShell()
    expect(copies.plain).toBe(0)
    expect(second.configuration).toBe(first.configuration)
    expect(second.host.projects).toBe(first.host.projects)
    expect(Object.isFrozen(second.configuration)).toBe(true)
    // The coordinator writes some of its state in place; the next broadcast still carries the write.
    control.state.configuration.enabledProviders = ['claude']
    const third = control.broadcastShell()
    expect(third.configuration).not.toBe(first.configuration)
    expect(third.configuration.enabledProviders).toEqual(['claude'])
    expect(third.host.projects).toBe(first.host.projects)
    expect(copies.plain).toBe(0)
  })

  it('carries an unchanged thread as the record the last broadcast carried, and a changed one afresh', () => {
    const control = fixture()
    const first = control.broadcastShell()
    const [one, two] = control.state.host.threads as [AgentThread, AgentThread]
    control.state.host = { ...control.state.host, threads: [one, { ...two, title: 'Renamed' }] }
    const second = control.broadcastShell()
    expect(second.host.threads[0]).toBe(first.host.threads[0])
    expect(second.host.threads[1]).not.toBe(first.host.threads[1])
    expect(second.host.threads[1]!.title).toBe('Renamed')
    expect(second.host.threads.every(item => item.messages.length === 0 && Object.isFrozen(item))).toBe(true)
    // A mark is the coordinator's, not the record's: earning one makes the record again, and keeping it does not.
    control.finishedUnread.restore(['one'])
    const third = control.broadcastShell()
    expect(third.host.threads[0]).not.toBe(second.host.threads[0])
    expect(third.host.threads[0]!.finishedUnread).toBe(true)
    expect(control.broadcastShell().host.threads[0]).toBe(third.host.threads[0])
    control.finishedUnread.restore([])
    expect(control.broadcastShell().host.threads[0]!.finishedUnread).toBeUndefined()
  })

  it('holds what shell() gives after every kind of change', () => {
    const control = fixture()
    const same = () => expect(JSON.parse(JSON.stringify(control.broadcastShell()))).toEqual(JSON.parse(JSON.stringify(control.shell())))
    same()
    control.state.notice = 'Synthetic notice'; same()
    control.state.configuration.enabledProviders = ['codex']; same()
    control.state.host = { ...control.state.host, threads: [...control.state.host.threads, thread('three', { summary: { messageCount: 1, activityCount: 0, lastAssistant: { id: 'three-reply', text: 'Kept', createdAt: at } } })] }; same()
    control.state.host = { ...control.state.host, threads: control.state.host.threads.slice(1) }; same()
    control.finishedUnread.restore(['two']); same()
    control.state.host = { ...control.state.host, projects: [] }; same()
  })
})
