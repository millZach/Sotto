// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { REMOTE_COMMANDS, REMOTE_CONFIGURATION_FIELDS, REMOTE_HOST_UPDATE_ACTIONS, REMOTE_OPENCODE_SIGN_IN_OPERATIONS, REMOTE_SIGN_IN_OPERATIONS, REMOTE_USAGE_OPERATIONS, remoteCommandRefusal, remoteHostUpdateRefusal, remoteUsageRefusal } from '../../../src/host/remoteCommands'
import { agentCommandSchema, type AgentCommand } from '../../../src/shared/agents'
import { HOST_UPDATE_REQUEST_ACTIONS, hostRequestSchema, commandFromProtocolV1, protocolAgentCommandSchema } from '../../../src/shared/hostProtocol'

/** Commands that stay on the host machine. A new command type must land here or in REMOTE_COMMANDS. */
const HOST_LOCAL = ['set-aside-send', 'credential', 'check-reasoning', 'update-client', 'open-thread-folder']
/** Fields only the desktop window sends, which its router reads and never forwards to a host (ADR-0074). */
// The desktop's router reads these and never sends them on: the host a patch or Update all's press names (ADR-0074, ADR-0077).
// A desktop window names the machine a command acts on and its router never sends the name on (ADR-0074, ADR-0077):
// a settings save, Update all, and Settings > Providers' presses on this computer's own clients.
const WINDOW_ONLY: Partial<Record<AgentCommand['type'], string[]>> = { configure: ['hostId'], 'queue-client-updates': ['hostId'],
  connect: ['hostId'], disconnect: ['hostId'], refresh: ['hostId'], 'check-client-updates': ['hostId'], 'update-client': ['hostId'] }
type Option = { shape: { type: { value?: string; options?: string[] } } & Record<string, unknown> }
const schemaFields = new Map((agentCommandSchema.options as unknown as Option[]).flatMap(option => {
  const types = option.shape.type.options ?? [option.shape.type.value!]
  return types.map(type => [type, Object.keys(option.shape).filter(key => key !== 'type').sort()] as const)
}))
const refuse = (command: AgentCommand, mayAnswer = false, askingProviderModes?: string[]) => remoteCommandRefusal(command, { mayAnswer, askingProviderModes })

describe('remote command allow-list', () => {
  it('keeps unconfirmed-send recovery desktop-only', () => {
    const command = agentCommandSchema.parse({ type: 'set-aside-send', threadId: 'thread', draftId: 'bc746d85-565c-4e06-b091-556d98551676' })
    expect(refuse(command, true)).toBe('forbidden')
    expect(commandFromProtocolV1(protocolAgentCommandSchema.parse(command))).toEqual(command)
  })

  it('accepts v1 connects with optional false-only feedback without granting any other field or command', () => {
    for (const provider of [undefined, 'codex'] as const) {
      for (const feedback of [{}, { notice: false }] as const) {
        const command = { type: 'connect', ...(provider ? { provider } : {}), ...feedback } as const
        const wire = { v: 1, id: 'connect', session: 'session', op: 'command', command }
        expect(hostRequestSchema.safeParse(wire).success).toBe(true)
        expect(commandFromProtocolV1(protocolAgentCommandSchema.parse(command))).toEqual(command)
        for (const mayAnswer of [false, true]) expect(refuse(command, mayAnswer)).toBeNull()
      }
    }
    for (const notice of [true, 'Approved', {}, null]) {
      const command = { type: 'connect', notice }
      expect(protocolAgentCommandSchema.safeParse(command).success).toBe(false)
      expect(refuse(command as unknown as AgentCommand, true)).toBe('forbidden')
    }
    for (const command of [
      { type: 'connect', notice: false, approved: true },
      { type: 'interrupt', threadId: 'thread', notice: false },
      { type: 'voice', action: 'mute', notice: false },
    ]) {
      expect(protocolAgentCommandSchema.safeParse(command).success).toBe(false)
      expect(refuse(command as unknown as AgentCommand, true)).toBe('forbidden')
    }
  })
  it('lets a paired client change only the coordinator settings decided on purpose, none of them a key, endpoint or voice engine', () => {
    expect([...REMOTE_CONFIGURATION_FIELDS].sort()).toEqual(['defaultModelId', 'enabled', 'enabledProviders', 'newThreadModelId', 'newThreadReasoningEffort',
      'newThreadRuntimeMode', 'projectsDirectory', 'provider', 'reasoning', 'reasoningEffort', 'reasoningModel'])
    for (const patch of [{ speak: false }, { followupLimit: 3 }]) expect(() => commandFromProtocolV1(protocolAgentCommandSchema.parse({ type: 'configure', patch })), Object.keys(patch)[0]).toThrow()
    for (const patch of [{ speechVoice: 'F2' }, { speechProvider: 'grok' }, { wakeModelDirectory: '/tmp' }])
      expect(refuse({ type: 'configure', patch } as AgentCommand, true), Object.keys(patch)[0]).toBe('forbidden')
  })
  it('takes a host’s projects directory and new-thread defaults, and a permission default that grants only with the answer policy (ADR-0074)', () => {
    for (const patch of [{ projectsDirectory: '/home/zach/projects' }, { newThreadModelId: 'claude:sonnet' }, { newThreadReasoningEffort: 'high' },
      { newThreadRuntimeMode: 'approval-required' }, { newThreadRuntimeMode: null }] as const)
      expect(refuse({ type: 'configure', patch } as AgentCommand), Object.keys(patch)[0]).toBeNull()
    for (const mode of ['auto-accept-edits', 'auto', 'full-access'] as const) {
      expect(refuse({ type: 'configure', patch: { newThreadRuntimeMode: mode } }), mode).toBe('forbidden')
      expect(refuse({ type: 'configure', patch: { newThreadRuntimeMode: mode } }, true), mode).toBeNull()
    }
    // The desktop's router reads which host a patch is for; a paired client never names one.
    expect(refuse({ type: 'configure', patch: { projectsDirectory: '/srv' }, hostId: '11111111-1111-4111-8111-111111111111' }, true)).toBe('forbidden')
  })
  it('decides every command type and every field the schema knows, so nothing new is remote by default', () => {
    for (const [type, fields] of schemaFields) {
      if (HOST_LOCAL.includes(type)) { expect(REMOTE_COMMANDS[type as AgentCommand['type']], type).toBeUndefined(); continue }
      const own = WINDOW_ONLY[type as AgentCommand['type']] ?? []
      expect([...(REMOTE_COMMANDS[type as AgentCommand['type']] ?? ['(missing)'])].sort(), type).toEqual(fields.filter(field => !own.includes(field)))
    }
    expect([...schemaFields.keys()].sort()).toEqual([...new Set([...HOST_LOCAL, ...Object.keys(REMOTE_COMMANDS)])].sort())
  })
  it('decides every host request: reads and the session, commands through their own list, sign-in and Usage requests', () => {
    expect([...REMOTE_SIGN_IN_OPERATIONS]).toEqual(['sign-in-start', 'sign-in-read', 'sign-in-code', 'sign-in-cancel'])
    expect([...REMOTE_USAGE_OPERATIONS]).toEqual(['usage-read', 'usage-refresh', 'usage-clear'])
    const decided = ['hello', 'shell', 'detail', 'events', 'observe', 'command', 'preview', 'receipt', 'git-refs', 'git-changed-files', 'git-pull-request',
      'stage-attachment', 'attachment-content', 'host-folders', ...REMOTE_SIGN_IN_OPERATIONS,
      // A host's own OpenCode signed in to model sources for the desktop that asks (#1107): the same trust as a sign-in.
      ...REMOTE_OPENCODE_SIGN_IN_OPERATIONS,
      // Numeric Usage reads grant nothing; Clear requires the client's current remote-answer policy (ADR-0078).
      ...REMOTE_USAGE_OPERATIONS,
      // Explicit native recovery requires answer-check and current remote-answer authority; it sends no answer.
      'check-answer',
      // Only an advertised and accepted desktop terminal feature admits these operations (ADR-0066).
      // Reading a preview and observing a detail grant nothing; hook dispatch rechecks current Can answer.
      'terminal-approval', 'observe-terminals', 'answer-terminal',
      // Optional Watcher paths require an SSH-recorded desktop and use their own owning-host guards.
      // Neither becomes an ordinary remote command or grants answer authority.
      'watcher-control', 'watcher-read',
      'watcher-phone-read', 'watcher-phone-send', 'watcher-phone-answer', 'watcher-phone-prepare-stop-all', 'watcher-phone-stop-all',
      // Optional phone management: pairing admits watching; permissive mode changes recheck Can answer.
      'watcher-phone-set-permission', 'watcher-phone-watch', 'watcher-phone-unwatch',
      // A thread's Files, Changes and Agents: reads only, never commands (ADR-0025, October 5 amendment).
      'thread-files', 'thread-file-preview', 'thread-changes', 'thread-changes-review', 'subagent-page', 'subagent-assignments',
      // The machine's host facts: numbers and the system's own name, read only by a desktop that lists host-facts (#1031).
      'host-facts',
      // A started thread's handover, read only on a listener that offers thread-starts, and only when the user asks (#1028).
      'start-handover',
      // A host update the host runs on itself: a recorded desktop whose remote-answer policy lets it answer (ADR-0088).
      'host-update']
    const ops = (hostRequestSchema.options as unknown as { shape: { op: { value: string } } }[]).map(option => option.shape.op.value)
    expect(ops.sort()).toEqual([...decided].sort())
  })
  it('lets only a recorded desktop that may answer have its host update itself, naming a version and never a URL or path (ADR-0088)', () => {
    expect([...REMOTE_HOST_UPDATE_ACTIONS]).toEqual([...HOST_UPDATE_REQUEST_ACTIONS])
    expect(remoteHostUpdateRefusal({ desktop: true, mayAnswer: true })).toBeNull()
    // A phone, a desktop the launch script never recorded, and a desktop whose grant was revoked with --deny-answers.
    expect(remoteHostUpdateRefusal({ desktop: false, mayAnswer: true })).toBe('forbidden')
    expect(remoteHostUpdateRefusal({ desktop: false, mayAnswer: false })).toBe('forbidden')
    expect(remoteHostUpdateRefusal({ desktop: true, mayAnswer: false })).toBe('forbidden')
    const base = { v: 1, id: 'update', session: 'session', op: 'host-update' }
    for (const action of HOST_UPDATE_REQUEST_ACTIONS) expect(hostRequestSchema.safeParse({ ...base, action }).success, action).toBe(true)
    expect(hostRequestSchema.safeParse({ ...base, action: 'install', version: '0.2.0', file: 'Sotto-host-0.2.0-linux-x64.tar.gz', sha256: 'a'.repeat(64) }).success).toBe(true)
    for (const extra of [{ releasesUrl: 'http://127.0.0.1:1' }, { installPath: '/tmp' }, { op: 'host-update', action: 'rollback' }, { sha256: 'not hex' }, { node: '/usr/bin/node' }])
      expect(hostRequestSchema.safeParse({ ...base, action: 'fetch', ...extra }).success, JSON.stringify(extra)).toBe(false)
  })
  it('admits numeric Usage reads and refreshes, and requires the answer policy for Clear', () => {
    for (const operation of ['usage-read', 'usage-refresh'] as const) {
      for (const mayAnswer of [false, true]) expect(remoteUsageRefusal(operation, mayAnswer), operation).toBeNull()
    }
    expect(remoteUsageRefusal('usage-clear', false)).toBe('forbidden')
    expect(remoteUsageRefusal('usage-clear', true)).toBeNull()
    const base = { v: 1, id: 'usage', session: 'session' }
    for (const request of [
      { ...base, op: 'usage-read', query: { providerIds: ['claude'] } },
      { ...base, op: 'usage-refresh', providerIds: ['claude'] },
      { ...base, op: 'usage-clear', request: { expectedRevision: 1 } },
    ]) {
      expect(hostRequestSchema.safeParse(request).success, request.op).toBe(true)
      expect(hostRequestSchema.safeParse({ ...request, approved: true }).success, request.op).toBe(false)
    }
    expect(hostRequestSchema.safeParse({ ...base, op: 'usage-read', query: { hostIds: ['other-host'] } }).success).toBe(false)
    expect(hostRequestSchema.safeParse({ ...base, op: 'usage-clear', request: { expectedRevision: 1, approved: true } }).success).toBe(false)
  })
  it('takes the client update line only on a listener that offers client-updates, and the waiting update-client nowhere (#480)', () => {
    for (const command of [{ type: 'queue-client-updates', providers: ['codex', 'grok'] }, { type: 'cancel-client-updates', providers: ['codex'] }] as AgentCommand[]) {
      expect(refuse(command, true), command.type).toBe('forbidden')
      expect(remoteCommandRefusal(command, { mayAnswer: false, clientUpdates: true }), command.type).toBeNull()
    }
    expect(remoteCommandRefusal({ type: 'update-client', provider: 'codex' }, { mayAnswer: true, clientUpdates: true })).toBe('forbidden')
  })
  it('takes Continue as a thread only on a listener that offers thread-starts, with no field beyond its own (#1028)', () => {
    const command = { type: 'continue-agent', threadId: 'thread', agentId: 'codex-agent-1', newThreadId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', modelId: 'codex:model', workingCopy: 'shared' } as AgentCommand
    expect(remoteCommandRefusal(command, { mayAnswer: true })).toBe('forbidden')
    expect(remoteCommandRefusal(command, { mayAnswer: false, threadStarts: true })).toBeNull()
    expect(remoteCommandRefusal({ ...command, approved: true } as unknown as AgentCommand, { mayAnswer: true, threadStarts: true })).toBe('forbidden')
    // Fork from here goes the same way (E5b).
    const fork = { type: 'fork-thread', threadId: 'thread', messageId: 'reply', newThreadId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', modelId: 'codex:model', workingCopy: 'independent', baseBranch: 'main' } as AgentCommand
    expect(remoteCommandRefusal(fork, { mayAnswer: true })).toBe('forbidden')
    expect(remoteCommandRefusal(fork, { mayAnswer: false, threadStarts: true })).toBeNull()
    expect(remoteCommandRefusal({ ...fork, agentId: 'codex-agent-1' } as unknown as AgentCommand, { mayAnswer: true, threadStarts: true })).toBe('forbidden')
    const base = { v: 1, id: 'read', session: 'session' }
    expect(hostRequestSchema.safeParse({ ...base, op: 'start-handover', threadId: 'thread' }).success).toBe(true)
    expect(hostRequestSchema.safeParse({ ...base, op: 'start-handover', threadId: 'thread', text: 'words' }).success).toBe(false)
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
