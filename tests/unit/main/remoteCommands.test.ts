// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { REMOTE_COMMANDS, remoteCommandRefusal } from '../../../src/host/remoteCommands'
import { agentCommandSchema, type AgentCommand } from '../../../src/shared/agents'

/** Commands that stay on the host machine. A new command type must land here or in REMOTE_COMMANDS. */
const HOST_LOCAL = ['credential', 'check-reasoning', 'update-client', 'preview-voice', 'utterance', 'voice', 'voice-state', 'open-thread-folder', 'membership']
type Option = { shape: { type: { value?: string; options?: string[] } } & Record<string, unknown> }
const schemaFields = new Map((agentCommandSchema.options as unknown as Option[]).flatMap(option => {
  const types = option.shape.type.options ?? [option.shape.type.value!]
  return types.map(type => [type, Object.keys(option.shape).filter(key => key !== 'type').sort()] as const)
}))
const refuse = (command: AgentCommand, mayAnswer = false, askingProviderModes?: string[]) => remoteCommandRefusal(command, { mayAnswer, askingProviderModes })

describe('remote command allow-list', () => {
  it('decides every command type and every field the schema knows, so nothing new is remote by default', () => {
    for (const [type, fields] of schemaFields) {
      if (HOST_LOCAL.includes(type)) { expect(REMOTE_COMMANDS[type as AgentCommand['type']], type).toBeUndefined(); continue }
      expect([...(REMOTE_COMMANDS[type as AgentCommand['type']] ?? ['(missing)'])].sort(), type).toEqual(fields)
    }
    expect([...schemaFields.keys()].sort()).toEqual([...new Set([...HOST_LOCAL, ...Object.keys(REMOTE_COMMANDS)])].sort())
  })
  it('refuses host-local commands and fields outside the list', () => {
    for (const command of [
      { type: 'credential', slot: 'reasoning', value: 'not-a-real-key' }, { type: 'membership', action: 'signin' },
      { type: 'open-thread-folder', threadId: 'thread' }, { type: 'update-client', provider: 'codex' }, { type: 'voice', action: 'mute' },
    ] as AgentCommand[]) expect(refuse(command, true), command.type).toBe('forbidden')
    expect(refuse({ type: 'interrupt', threadId: 'thread', extra: true } as unknown as AgentCommand, true)).toBe('forbidden')
    expect(refuse({ type: 'configure', patch: { membershipEndpoint: 'https://untrusted.example' } } as AgentCommand, true)).toBe('forbidden')
    expect(refuse({ type: 'interrupt', threadId: 'thread' })).toBeNull()
  })
  it('asks for the answer policy before a permission setting or discarding uncommitted work', () => {
    const gated: AgentCommand[] = [
      { type: 'create-thread', projectId: 'project', title: 'Bypass', modelId: 'devin', providerMode: 'bypass' },
      { type: 'configure-thread', threadId: 'thread', providerMode: 'bypass' },
      { type: 'create-thread', projectId: 'project', title: 'Full', modelId: 'codex', runtimeMode: 'full-access' },
      { type: 'configure-thread', threadId: 'thread', runtimeMode: 'full-access' },
      { type: 'reclaim-thread-worktree', threadId: 'thread', withUncommittedChanges: true },
      { type: 'restore-thread-branch', threadId: 'thread', withUncommittedChanges: true },
      { type: 'answer', threadId: 'thread', requestId: 'request', answer: 'Allow', approved: true },
    ]
    for (const command of gated) {
      expect(refuse(command, false, ['ask']), command.type).toBe('forbidden')
      expect(refuse(command, true, ['ask']), command.type).toBeNull()
    }
  })
  it('lets a device without the policy pick a mode that allows nothing and leave clean folders', () => {
    expect(refuse({ type: 'create-thread', projectId: 'project', title: 'Asks', modelId: 'devin', providerMode: 'ask' }, false, ['ask-first', 'ask'])).toBeNull()
    expect(refuse({ type: 'configure-thread', threadId: 'thread', providerMode: 'ask' }, false, ['ask-first', 'ask'])).toBeNull()
    expect(refuse({ type: 'configure-thread', threadId: 'thread', providerMode: 'ask' }, false, undefined)).toBe('forbidden')
    // Being first in the list is not what makes a mode free: Smart allows edits wherever the provider lists it.
    expect(refuse({ type: 'configure-thread', threadId: 'thread', providerMode: 'smart' }, false, ['plan'])).toBe('forbidden')
    expect(refuse({ type: 'reclaim-thread-worktree', threadId: 'thread', withUncommittedChanges: false })).toBeNull()
    expect(refuse({ type: 'restore-thread-branch', threadId: 'thread' })).toBeNull()
  })
})
