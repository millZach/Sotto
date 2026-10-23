// @vitest-environment node
// #1032: what Watcher and a delegating thread are offered with Work across machines off and on.
import { describe, expect, it } from 'vitest'
import { DELEGATION_TOOL_DEFINITIONS, delegationToolDefinitions } from '../../../src/main/agents/delegationTools'
import { WATCHER_MACHINES_PROMPT, WATCHER_ROLES_PROMPT, WATCHER_SYSTEM_PROMPT, watcherSystemPrompt } from '../../../src/main/agents/watcherPrompt'
import { WATCHER_TOOL_DEFINITIONS, watcherToolDefinitions } from '../../../src/main/agents/watcherTools'
import { LIST_MACHINES_TOOL } from '../../../src/shared/delegation'

type Schema = { properties: Record<string, { description?: string; enum?: string[] }>; required?: string[] }
const tool = (definitions: readonly { name: string; description?: string; inputSchema: unknown }[], name: string) => {
  const found = definitions.find(item => item.name === name)
  return found ? { description: found.description ?? '', schema: found.inputSchema as Schema } : undefined
}

describe('Watcher with Work across machines', () => {
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
  it('advertises no placement or newWorkersStart in any result while it is off, and both while it is on', () => {
    const offered = (roles: boolean, machines: boolean) => JSON.stringify(watcherToolDefinitions(roles, machines))
    const output = (roles: boolean, machines: boolean, name: string) => JSON.stringify(watcherToolDefinitions(roles, machines).find(item => item.name === name)!.outputSchema)
    for (const roles of [false, true]) {
      for (const field of ['placement', 'newWorkersStart']) expect(offered(roles, false)).not.toContain(field)
      expect(output(roles, true, 'start_thread')).toContain('"placement"')
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
  it('offers a machine, a system and the machine list while it is on, and says a delegated thread starts on This computer for now', () => {
    for (const roles of [false, true]) {
      const definitions = delegationToolDefinitions(roles, true), delegate = tool(definitions, 'delegate')!
      expect(delegate.schema.properties['machine']!.description).toContain(LIST_MACHINES_TOOL)
      expect(delegate.schema.properties['os']!.enum).toEqual(['windows', 'macos', 'linux'])
      expect(delegate.description).toContain('a delegated thread starts only on This computer for now')
      expect(tool(definitions, LIST_MACHINES_TOOL)!.description).toContain('newWorkersStart')
    }
  })
})
