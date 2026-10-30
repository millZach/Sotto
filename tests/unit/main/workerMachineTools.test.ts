// @vitest-environment node
// #1032: what Watcher and a delegating thread are offered with Work across machines off and on.
import { describe, expect, it } from 'vitest'
import { DELEGATION_TOOL_DEFINITIONS, delegationToolDefinitions } from '../../../src/main/agents/delegationTools'
import { WATCHER_MACHINES_PROMPT, WATCHER_ROLES_PROMPT, WATCHER_SYSTEM_PROMPT, watcherSystemPrompt } from '../../../src/main/agents/watcherPrompt'
import { WATCHER_TOOL_DEFINITIONS, watcherToolDefinitions } from '../../../src/main/agents/watcherTools'
import { LIST_MACHINES_TOOL } from '../../../src/shared/delegation'
import { WorkerAdmission } from '../../../src/main/agents/workerAdmission'

type Schema = { properties: Record<string, { description?: string; enum?: string[] }>; required?: string[] }
const tool = (definitions: readonly { name: string; description?: string; inputSchema: unknown }[], name: string) => {
  const found = definitions.find(item => item.name === name)
  return found ? { description: found.description ?? '', schema: found.inputSchema as Schema } : undefined
}

describe('Watcher with Work across machines', () => {
  it('reserves machine slots atomically, counts running reservations once and queues excess starts in order', async () => {
    const running = new Set<string>(), started: string[] = []
    const admission = new WorkerAdmission({ ceiling: () => 2, working: () => running })
    expect(admission.join('one', 'here', () => started.push('one'))).toBe('working')
    admission.bind('one', 'thread-one'); running.add('thread-one')
    expect(admission.join('two', 'here', () => started.push('two'))).toBe('working')
    expect(admission.join('three', 'here', () => started.push('three'))).toBe('queued')
    expect(admission.join('four', 'here', () => started.push('four'))).toBe('queued')
    expect(admission.view('four')).toEqual({ state: 'queued', ahead: 1, waiting: 2 })
    expect(admission.join('three', 'here', () => started.push('duplicate'))).toBe('queued')
    running.delete('thread-one'); admission.leave('one')
    await Promise.resolve()
    expect(started).toEqual(['three'])
    expect(admission.reserved('here')).toBe(2)
    expect(admission.waiting('here')).toBe(1)
    admission.leave('two'); await Promise.resolve()
    expect(started).toEqual(['three', 'four'])
    admission.close()
  })

  it('cancels queued angles, admits independently on another machine and never interrupts work when the ceiling falls', async () => {
    let ceiling = 1
    const running = new Set(['outside']), started: string[] = []
    const admission = new WorkerAdmission({ ceiling: () => ceiling, working: machine => machine === 'here' ? running : new Set() })
    expect(admission.join('cancelled', 'here', () => started.push('cancelled'))).toBe('queued')
    expect(admission.join('next', 'here', () => started.push('next'))).toBe('queued')
    expect(admission.join('remote', 'away', () => started.push('remote'))).toBe('working')
    admission.leave('cancelled')
    running.clear(); admission.refresh('here'); await Promise.resolve()
    expect(started).toEqual(['next'])
    ceiling = 2
    expect(admission.join('more', 'here', () => started.push('more'))).toBe('working')
    ceiling = 1; admission.refresh()
    expect(admission.reserved('here')).toBe(2)
    expect(admission.join('waiting', 'here', () => started.push('waiting'))).toBe('queued')
    admission.leave('more'); await Promise.resolve()
    expect(started).toEqual(['next'])
    admission.leave('next'); admission.close(); await Promise.resolve()
    expect(started).toEqual(['next'])
  })

  it('offers no machine or system while it is off, as before', () => {
    for (const roles of [false, true]) {
      const start = tool(watcherToolDefinitions(roles), 'start_thread')!
      expect(start.schema.properties).not.toHaveProperty('machine')
      expect(start.schema.properties).not.toHaveProperty('os')
      expect(start.description).not.toContain('newWorkersStart')
      expect(tool(watcherToolDefinitions(roles), 'list_machines')!.description).not.toContain('newWorkersStart')
    }
    expect(WATCHER_TOOL_DEFINITIONS).toEqual(watcherToolDefinitions(false, false))
  })
  it('advertises no placement, startedFrom or newWorkersStart in any result while it is off, and all of them while it is on', () => {
    const offered = (roles: boolean, machines: boolean) => JSON.stringify(watcherToolDefinitions(roles, machines))
    const output = (roles: boolean, machines: boolean, name: string) => JSON.stringify(watcherToolDefinitions(roles, machines).find(item => item.name === name)!.outputSchema)
    for (const roles of [false, true]) {
      // startedFrom carries a test run's snapshot (#1033): its untracked files and their count are Work across machines' too.
      for (const field of ['placement', 'newWorkersStart', 'startedFrom', 'untracked', 'untrackedCount']) expect(offered(roles, false)).not.toContain(field)
      expect(output(roles, true, 'start_thread')).toContain('"placement"')
      expect(output(roles, true, 'start_thread')).toContain('"startedFrom"')
      expect(output(roles, true, 'start_thread')).toContain('"untrackedCount"')
      // A check waiting its turn says how many are ahead (#1312), only while it is on; Watcher never names a check itself.
      expect(output(roles, true, 'start_thread')).toContain('"ahead"')
      expect(output(roles, false, 'start_thread')).not.toContain('"ahead"')
      for (const machines of [false, true]) expect(tool(watcherToolDefinitions(roles, machines), 'start_thread')!.schema.properties).not.toHaveProperty('check')
      expect(tool(watcherToolDefinitions(roles, true), 'start_thread')!.description).toContain('One check runs at a time on a machine')
      expect(output(roles, true, 'list_machines')).toContain('"newWorkersStart"')
      // The rest of each result, and the refusal, are the same either way.
      expect(output(roles, false, 'start_thread')).toContain('"firstPromptReceiptId"')
      expect(output(roles, false, 'start_thread')).toContain('"refused"')
      expect(output(roles, false, 'list_machines')).toContain('"machines"')
      for (const name of watcherToolDefinitions(roles).map(item => item.name).filter(item => item !== 'start_thread' && item !== 'list_machines')) {
        expect(output(roles, true, name)).toBe(output(roles, false, name))
      }
    }
  })
  it('offers a machine and a system on start_thread, with or without worker roles, and says where a start that names neither goes', () => {
    for (const roles of [false, true]) {
      const start = tool(watcherToolDefinitions(roles, true), 'start_thread')!
      expect(start.schema.properties).toHaveProperty('machine')
      expect(start.schema.properties['os']!.enum).toEqual(['windows', 'macos', 'linux'])
      expect(start.schema.required).not.toContain('machine')
      expect(start.description).toContain('A system never falls back to another.')
      expect(tool(watcherToolDefinitions(roles, true), 'list_machines')!.description).toContain('newWorkersStart')
      // Only start_thread and list_machines change.
      for (const name of watcherToolDefinitions(roles, true).map(item => item.name).filter(item => item !== 'start_thread' && item !== 'list_machines')) {
        expect(tool(watcherToolDefinitions(roles, true), name)).toEqual(tool(watcherToolDefinitions(roles, false), name))
      }
    }
  })
  it('adds the placement lines to Watcher’s instructions only while it is on, after the role lines', () => {
    expect(watcherSystemPrompt(false, false)).toBe(WATCHER_SYSTEM_PROMPT)
    expect(watcherSystemPrompt(true, false)).toBe(`${WATCHER_SYSTEM_PROMPT}\n${WATCHER_ROLES_PROMPT}`)
    expect(watcherSystemPrompt(false, true)).toBe(`${WATCHER_SYSTEM_PROMPT}\n${WATCHER_MACHINES_PROMPT}`)
    expect(watcherSystemPrompt(true, true)).toBe(`${WATCHER_SYSTEM_PROMPT}\n${WATCHER_ROLES_PROMPT}\n${WATCHER_MACHINES_PROMPT}`)
    expect(WATCHER_MACHINES_PROMPT).toContain('AGENTS.md')
    expect(WATCHER_MACHINES_PROMPT).toContain('say in your reply which machine it is on and why')
  })
})

describe('delegate with Work across machines', () => {
  it('offers no machine, system or machine list while it is off, as before', () => {
    for (const roles of [false, true]) {
      const definitions = delegationToolDefinitions(roles)
      expect(tool(definitions, 'delegate')!.schema.properties).not.toHaveProperty('machine')
      expect(tool(definitions, 'delegate')!.schema.properties).not.toHaveProperty('os')
      expect(tool(definitions, LIST_MACHINES_TOOL)).toBeUndefined()
    }
    expect(DELEGATION_TOOL_DEFINITIONS).toEqual(delegationToolDefinitions(false, false))
  })
  it('offers a machine, a system and the machine list while it is on, and says a machine that is not connected is refused', () => {
    for (const roles of [false, true]) {
      const definitions = delegationToolDefinitions(roles, true), delegate = tool(definitions, 'delegate')!
      expect(delegate.schema.properties['machine']!.description).toContain(LIST_MACHINES_TOOL)
      expect(delegate.schema.properties['os']!.enum).toEqual(['windows', 'macos', 'linux'])
      expect(delegate.description).toContain('only while that machine is connected')
      expect(tool(definitions, LIST_MACHINES_TOOL)!.description).toContain('newWorkersStart')
    }
  })
})

// #1033: starting from a thread's branch, and saying a start is a test run, are Work across machines too.
describe('starting from a branch with Work across machines', () => {
  it('offers Watcher no thread to start from and no test run while it is off, and never a move', () => {
    for (const roles of [false, true]) for (const machines of [false, true]) {
      const properties = tool(watcherToolDefinitions(roles, machines), 'start_thread')!.schema.properties
      expect(properties).not.toHaveProperty('fromMove')
      expect(properties).not.toHaveProperty('fromOrigin')
      for (const name of ['fromThread', 'testRun']) expect(Object.hasOwn(properties, name)).toBe(machines)
      expect(tool(watcherToolDefinitions(roles, machines), 'start_thread')!.description.includes('fromThread')).toBe(machines)
    }
    expect(WATCHER_MACHINES_PROMPT).toContain('Set testRun only when the worker is there to run tests')
  })
  it('offers a delegating thread from_my_branch and test_run only while it is on', () => {
    for (const roles of [false, true]) for (const machines of [false, true]) {
      const delegate = tool(delegationToolDefinitions(roles, machines), 'delegate')!
      for (const name of ['from_my_branch', 'test_run']) expect(Object.hasOwn(delegate.schema.properties, name)).toBe(machines)
      expect(delegate.description.includes('from_my_branch')).toBe(machines)
      // One check at a time per machine, and the reply a check's brief asks for (#1312): only while it is on.
      expect(delegate.description.includes('One check runs at a time on a machine')).toBe(machines)
      expect(delegate.description.includes('the verdict, the counts and the failing lines, inside 32 KiB')).toBe(machines)
    }
    // A thread on a headless host is offered test_run with its own machine's queue, shared with Watcher's checks there, and
    // from_my_branch, its branch or a check's snapshot (#1312, #1316 part 2). With Work across machines off it is offered neither.
    for (const machines of [false, true]) {
      const hosted = tool(delegationToolDefinitions(false, machines, 'this-machine'), 'delegate')!
      expect(Object.hasOwn(hosted.schema.properties, 'test_run')).toBe(machines)
      expect(Object.hasOwn(hosted.schema.properties, 'from_my_branch')).toBe(machines)
      expect(hosted.description.includes('One check runs at a time on this machine, yours and Watcher\'s alike')).toBe(machines)
      expect(hosted.description.includes('snapshot')).toBe(machines)
    }
  })
})
