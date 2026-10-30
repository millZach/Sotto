// @vitest-environment node
// #1041: the tools Watcher and a delegating thread are offered, with worker roles off and on.
import { describe, expect, it } from 'vitest'
import { DELEGATION_TOOL_DEFINITIONS, delegationToolDefinitions } from '../../../src/main/agents/delegationTools'
import { WATCHER_ROLES_PROMPT, WATCHER_SYSTEM_PROMPT, watcherSystemPrompt } from '../../../src/main/agents/watcherPrompt'
import { WATCHER_TOOL_DEFINITIONS, watcherToolDefinitions } from '../../../src/main/agents/watcherTools'
import { WORKER_KIND_LIST } from '../../../src/shared/workerRoles'

type Schema = { properties: Record<string, { description?: string }>; required?: string[] }
const tool = (definitions: readonly { name: string; description?: string; inputSchema: unknown }[], name: string) => {
  const found = definitions.find(item => item.name === name)!
  return { description: found.description ?? '', schema: found.inputSchema as Schema }
}

describe('Watcher\'s start_thread', () => {
  it('offers no role and requires a model with worker roles off, as it always has', () => {
    const start = tool(watcherToolDefinitions(false), 'start_thread')
    expect(start.schema.properties).not.toHaveProperty('role')
    expect(start.schema.required).toContain('modelId')
    expect(start.description).not.toContain('role')
    expect(WATCHER_TOOL_DEFINITIONS).toEqual(watcherToolDefinitions(false))
  })
  it('offers a role and leaves the model to it with worker roles on', () => {
    const start = tool(watcherToolDefinitions(true), 'start_thread')
    expect(start.schema.properties).toHaveProperty('role')
    expect(start.schema.properties['speed']!.description).toContain('null means standard speed')
    expect(start.description).toContain('model, effort, speed and permission')
    expect(start.schema.required).not.toContain('modelId')
    expect(start.description).toContain(WORKER_KIND_LIST)
    expect(start.description).toContain('never wider than the new-thread default')
    // Only start_thread changes.
    for (const name of watcherToolDefinitions(true).map(item => item.name).filter(item => item !== 'start_thread')) {
      expect(tool(watcherToolDefinitions(true), name)).toEqual(tool(watcherToolDefinitions(false), name))
    }
  })
})

describe('Watcher\'s system prompt', () => {
  it('is the base prompt with worker roles off and adds the role lines with them on', () => {
    expect(watcherSystemPrompt(false)).toBe(WATCHER_SYSTEM_PROMPT)
    expect(watcherSystemPrompt(true).startsWith(WATCHER_SYSTEM_PROMPT)).toBe(true)
    expect(watcherSystemPrompt(true)).toContain(WATCHER_ROLES_PROMPT)
    expect(WATCHER_ROLES_PROMPT).toContain('Orchestrating')
    expect(WATCHER_ROLES_PROMPT).toContain('model, effort, speed or permission')
  })
})

describe('delegate', () => {
  it('asks for the provider and model by name with worker roles off', () => {
    const delegate = tool(delegationToolDefinitions(false), 'delegate')
    expect(delegate.description).toContain('name the provider, model, effort and permission')
    expect(delegate.schema.properties['model']!.description).not.toContain('use the role')
    expect(DELEGATION_TOOL_DEFINITIONS).toEqual(delegationToolDefinitions(false))
  })
  it('names the kind of work and leaves the rest to the role with worker roles on', () => {
    const delegate = tool(delegationToolDefinitions(true), 'delegate')
    expect(delegate.description).toContain('worker role')
    for (const field of ['provider', 'model', 'effort', 'speed', 'permission']) expect(delegate.schema.properties[field]!.description).toContain('Leave it out to use the role.')
    expect(delegate.schema.required).toEqual(tool(delegationToolDefinitions(false), 'delegate').schema.required)
  })
})
