// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { REMOTE_COMMANDS, REMOTE_CONFIGURATION_FIELDS, REMOTE_SIGN_IN_OPERATIONS, remoteCommandRefusal } from '../../../src/host/remoteCommands'
import { agentCommandSchema, type AgentCommand } from '../../../src/shared/agents'
import { hostRequestSchema } from '../../../src/shared/hostProtocol'

/** Commands that stay on the host machine. A new command type must land here or in REMOTE_COMMANDS. */
const HOST_LOCAL = ['credential', 'check-reasoning', 'update-client', 'preview-voice', 'utterance', 'voice', 'voice-state', 'open-thread-folder',
  'assign', 'unassign', 'pause', 'resume', 'pause-draft', 'resume-draft', 'cancel-request', 'select-attention', 'next', 'later']
type Option = { shape: { type: { value?: string; options?: string[] } } & Record<string, unknown> }
const schemaFields = new Map((agentCommandSchema.options as unknown as Option[]).flatMap(option => {
  const types = option.shape.type.options ?? [option.shape.type.value!]
  return types.map(type => [type, Object.keys(option.shape).filter(key => key !== 'type').sort()] as const)
}))
const refuse = (command: AgentCommand, mayAnswer = false, askingProviderModes?: string[]) => remoteCommandRefusal(command, { mayAnswer, askingProviderModes })

describe('remote command allow-list', () => {
  it('lets a paired client change only the coordinator settings decided on purpose, none of them a key, endpoint or voice engine', () => {
    expect([...REMOTE_CONFIGURATION_FIELDS].sort()).toEqual(['defaultModelId', 'enabled', 'enabledProviders', 'provider',
      'reasoning', 'reasoningEffort', 'reasoningModel'])
    for (const patch of [{ speak: false }, { followupLimit: 3 }]) expect(refuse({ type: 'configure', patch }), Object.keys(patch)[0]).toBe('forbidden')
    for (const patch of [{ speechVoice: 'F2' }, { speechProvider: 'grok' }, { wakeModelDirectory: '/tmp' }])
      expect(refuse({ type: 'configure', patch } as AgentCommand, true), Object.keys(patch)[0]).toBe('forbidden')
  })
  it('decides every command type and every field the schema knows, so nothing new is remote by default', () => {
    for (const [type, fields] of schemaFields) {
      if (HOST_LOCAL.includes(type)) { expect(REMOTE_COMMANDS[type as AgentCommand['type']], type).toBeUndefined(); continue }
      expect([...(REMOTE_COMMANDS[type as AgentCommand['type']] ?? ['(missing)'])].sort(), type).toEqual(fields)
    }
    expect([...schemaFields.keys()].sort()).toEqual([...new Set([...HOST_LOCAL, ...Object.keys(REMOTE_COMMANDS)])].sort())
  })
  it('decides every host request: reads and the session, commands through their own list, and the sign-in requests (ADR-0037)', () => {
    expect([...REMOTE_SIGN_IN_OPERATIONS]).toEqual(['sign-in-start', 'sign-in-read', 'sign-in-code', 'sign-in-cancel'])
    const decided = ['hello', 'shell', 'detail', 'events', 'observe', 'command', 'preview', 'receipt', 'git-refs', 'git-changed-files', 'git-pull-request',
      'stage-attachment', 'attachment-content', 'host-folders', ...REMOTE_SIGN_IN_OPERATIONS,
      // Explicit native recovery requires answer-check and current remote-answer authority; it sends no answer.
      'check-answer',
      // A thread's Files, Changes and Agents: reads only, never commands (ADR-0025, October 5 amendment).
      'thread-files', 'thread-file-preview', 'thread-changes', 'thread-changes-review', 'subagent-page', 'subagent-assignments']
    const ops = (hostRequestSchema.options as unknown as { shape: { op: { value: string } } }[]).map(option => option.shape.op.value)
    expect(ops.sort()).toEqual([...decided].sort())
  })
  it('takes the client update line only on a listener that offers client-updates, and the waiting update-client nowhere (#480)', () => {
    for (const command of [{ type: 'queue-client-updates', providers: ['codex', 'grok'] }, { type: 'cancel-client-updates', providers: ['codex'] }] as AgentCommand[]) {
      expect(refuse(command, true), command.type).toBe('forbidden')
      expect(remoteCommandRefusal(command, { mayAnswer: false, clientUpdates: true }), command.type).toBeNull()
    }
    expect(remoteCommandRefusal({ type: 'update-client', provider: 'codex' }, { mayAnswer: true, clientUpdates: true })).toBe('forbidden')
  })
  it('takes the user’s Babysit pull request and Stop babysitting without the answer policy, and no field beyond the pull request (ADR-0061)', () => {
    const url = 'https://github.com/o/r/pull/42'
    expect(refuse({ type: 'babysit-pull-request', threadId: 'thread', url })).toBeNull()
    expect(refuse({ type: 'stop-babysitting', threadId: 'thread', url })).toBeNull()
    expect(refuse({ type: 'babysit-pull-request', threadId: 'thread', url, startedBy: 'agent' } as AgentCommand, true)).toBe('forbidden')
  })
  it('refuses host-local commands and fields outside the list', () => {
    for (const command of [
      { type: 'credential', slot: 'reasoning', value: 'not-a-real-key' },
      { type: 'open-thread-folder', threadId: 'thread' }, { type: 'update-client', provider: 'codex' }, { type: 'voice', action: 'mute' },
    ] as AgentCommand[]) expect(refuse(command, true), command.type).toBe('forbidden')
    expect(refuse({ type: 'interrupt', threadId: 'thread', extra: true } as unknown as AgentCommand, true)).toBe('forbidden')
    expect(refuse({ type: 'interrupt', threadId: 'thread' })).toBeNull()
    expect(remoteCommandRefusal({ type: 'send' }, { mayAnswer: false, draftRequestId: 'request' })).toBe('forbidden')
    expect(remoteCommandRefusal({ type: 'send' }, { mayAnswer: true, draftRequestId: 'request' })).toBeNull()
    expect(remoteCommandRefusal({ type: 'send' }, { mayAnswer: false, draftRequestId: null })).toBeNull()
    expect(refuse({ type: 'save-thread-draft', threadId: 'thread', draftId: 'draft', text: 'Blue' })).toBeNull()
    // The window's own refresh is a read, which asks GitHub less, not more (#820).
    expect(refuse({ type: 'refresh-thread-worktree', threadId: 'thread', background: true })).toBeNull()
  })
  it('binds an atomic Send to this socket selection and refuses every unlisted draft field', () => {
    const draft = { threadId: 'thread', text: 'Blue', attachments: [] }
    const command = { type: 'send', draft } as const
    const context = { mayAnswer: true, selectedThreadId: 'thread', draftRequestId: 'native-question' }
    expect(remoteCommandRefusal(command, context)).toBeNull()
    for (const selectedThreadId of [undefined, null, 'other-thread']) {
      expect(remoteCommandRefusal(command, { ...context, selectedThreadId })).toBe('forbidden')
    }
    expect(remoteCommandRefusal(command, { ...context, mayAnswer: false })).toBe('forbidden')
    expect(remoteCommandRefusal(command, { ...context, mayAnswer: false, draftRequestId: null })).toBeNull()
    for (const field of ['approved', 'requestId', 'providerId', 'permissionChoice', 'extra']) {
      const extended = { ...command, draft: { ...draft, [field]: 'claimed' } }
      expect(remoteCommandRefusal(extended, context), field).toBe('forbidden')
      expect(hostRequestSchema.safeParse({ v: 1, id: 'command', session: 'session', op: 'command', command: extended }).success, field).toBe(false)
    }
    expect(hostRequestSchema.safeParse({ v: 1, id: 'command', session: 'session', op: 'command', command }).success).toBe(true)
    expect(hostRequestSchema.safeParse({ v: 1, id: 'legacy', session: 'session', op: 'command', command: { type: 'send' } }).success).toBe(true)
  })
  it('binds a targeted Compose to this socket selection without changing legacy Compose', () => {
    const command = { type: 'compose' as const, threadId: 'thread', text: 'The retained draft', attachments: [] }
    const context = { mayAnswer: true, selectedThreadId: 'thread', draftRequestId: 'native-question' }
    expect(remoteCommandRefusal(command, context)).toBeNull()
    for (const selectedThreadId of [undefined, null, 'other-thread']) {
      expect(remoteCommandRefusal(command, { ...context, selectedThreadId })).toBe('forbidden')
    }
    expect(remoteCommandRefusal(command, { ...context, mayAnswer: false })).toBe('forbidden')
    expect(remoteCommandRefusal({ type: 'compose', text: 'Legacy draft' }, { mayAnswer: false })).toBeNull()
    for (const field of ['approved', 'requestId', 'providerId', 'permissionChoice', 'extra']) {
      const extended = { ...command, [field]: 'claimed' }
      expect(remoteCommandRefusal(extended, context), field).toBe('forbidden')
      expect(hostRequestSchema.safeParse({ v: 1, id: 'save', session: 'session', op: 'command', command: extended }).success, field).toBe(false)
    }
    expect(hostRequestSchema.safeParse({ v: 1, id: 'save', session: 'session', op: 'command', command }).success).toBe(true)
  })
  it('applies command admission consistently while composing', () => {
    const command = { type: 'compose', text: 'Draft text' } as const
    expect(remoteCommandRefusal(command, { mayAnswer: false, draftRequestId: 'request' })).toBe('forbidden')
    expect(remoteCommandRefusal(command, { mayAnswer: true, draftRequestId: 'request' })).toBeNull()
    expect(remoteCommandRefusal(command, { mayAnswer: false, draftRequestId: null })).toBeNull()
  })
  it('asks for the answer policy before a permission setting or discarding uncommitted work', () => {
    const gated: AgentCommand[] = [
      { type: 'create-thread', projectId: 'project', title: 'Bypass', modelId: 'devin', providerMode: 'bypass' },
      { type: 'configure-thread', threadId: 'thread', providerMode: 'bypass' },
      { type: 'create-thread', projectId: 'project', title: 'Full', modelId: 'codex', runtimeMode: 'full-access' },
      { type: 'configure-thread', threadId: 'thread', runtimeMode: 'full-access' },
      { type: 'configure-thread', threadId: 'thread', runtimeMode: 'auto-accept-edits' },
      { type: 'create-thread', projectId: 'project', title: 'Auto', modelId: 'codex', runtimeMode: 'auto' },
      { type: 'reclaim-thread-worktree', threadId: 'thread', withUncommittedChanges: true },
      { type: 'reclaim-thread-worktree', threadId: 'thread', confirmedIgnored: ['.env'] },
      { type: 'restore-thread-branch', threadId: 'thread', withUncommittedChanges: true },
      { type: 'answer', threadId: 'thread', requestId: 'request', answer: 'Allow', approved: true },
      { type: 'save-thread-draft', threadId: 'thread', draftId: 'draft', text: 'Blue', requestId: 'request' },
    ]
    for (const command of gated) {
      expect(refuse(command, false, ['ask']), command.type).toBe('forbidden')
      expect(refuse(command, true, ['ask']), command.type).toBeNull()
    }
  })
  it('lets a device without the policy pick a mode that allows nothing and leave clean folders', () => {
    // Asking first is the runtime mode that grants nothing, so a paired device can always lower a thread back to it.
    expect(refuse({ type: 'configure-thread', threadId: 'thread', runtimeMode: 'approval-required' })).toBeNull()
    expect(refuse({ type: 'create-thread', projectId: 'project', title: 'Asks', modelId: 'codex', runtimeMode: 'approval-required' })).toBeNull()
    expect(refuse({ type: 'create-thread', projectId: 'project', title: 'Asks', modelId: 'devin', providerMode: 'ask' }, false, ['ask-first', 'ask'])).toBeNull()
    expect(refuse({ type: 'configure-thread', threadId: 'thread', providerMode: 'ask' }, false, ['ask-first', 'ask'])).toBeNull()
    expect(refuse({ type: 'configure-thread', threadId: 'thread', providerMode: 'ask' }, false, undefined)).toBe('forbidden')
    // Being first in the list is not what makes a mode free: Smart allows edits wherever the provider lists it.
    expect(refuse({ type: 'configure-thread', threadId: 'thread', providerMode: 'smart' }, false, ['plan'])).toBe('forbidden')
    expect(refuse({ type: 'reclaim-thread-worktree', threadId: 'thread', withUncommittedChanges: false })).toBeNull()
    expect(refuse({ type: 'restore-thread-branch', threadId: 'thread' })).toBeNull()
  })
})
