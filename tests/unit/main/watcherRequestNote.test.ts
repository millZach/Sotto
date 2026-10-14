// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { watcherMessageRequests, watcherMessagesAsTyped, watcherRequestLine, watcherRequestNote, watcherTextAsTyped,
  type WatcherMessageRequest } from '../../../src/main/agents/watcherRequestNote'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../../src/shared/agents'
import type { WatcherRequest } from '../../../src/shared/watcher'

/** The footer exactly as main appended it to the user's text before the request note existed. */
const footer = ({ requestId, hostId }: WatcherMessageRequest, projects = ['native:claude:project:' + randomUUID(), 'native:codex:project:' + randomUUID()]) =>
  `\n\n[Sotto Watcher request: ${requestId}. Local host: ${hostId}. Use this requestId for sotto_threads mutations. Known project IDs: ${projects.join(', ')}. Call list_projects for choices.]`
const grokLine = (request: WatcherMessageRequest) => watcherRequestLine(watcherRequestNote(request.requestId, request.hostId))
const someRequest = (): WatcherMessageRequest => ({ requestId: randomUUID(), hostId: randomUUID() })

describe('Watcher request note', () => {
  it('names the request and this computer and lists no projects', () => {
    const requestId = randomUUID(), hostId = randomUUID()
    const note = watcherRequestNote(requestId, hostId)
    expect(note).toContain(requestId)
    expect(note).toContain(hostId)
    expect(note).not.toMatch(/project/iu)
  })

  it('takes off only the line Sotto put after the message for its own request', () => {
    const typed = 'Check the release notes.\n\nThen tell me what is missing.', request = someRequest()
    // A message saved with the old footer, and one Grok Build was sent with its request line.
    expect(watcherTextAsTyped(typed + footer(request), request)).toBe(typed)
    expect(watcherTextAsTyped(typed + footer(request, []), request)).toBe(typed)
    expect(watcherTextAsTyped(typed + grokLine(request), request)).toBe(typed)
    // An image sent with no words carried the line alone.
    expect(watcherTextAsTyped(footer(request).slice(2), request)).toBe('')
    expect(watcherTextAsTyped(grokLine(request).slice(2), request)).toBe('')
  })

  it('leaves what the user typed, even a note or footer of their own', () => {
    const request = someRequest(), other = someRequest()
    const typed = [
      'Plain words',
      // An example the user typed: right shape, but not this message's request.
      `Explain this example:${grokLine(other)}`,
      `Explain this example:${footer(other)}`,
      // This request's own line, but with the user's words after it.
      `Before${grokLine(request)}\n\nAfter`,
      `Before${footer(request)}\n\nAfter`,
      `${`Typed${footer(request)}`.slice(0, -1)}] These are my words`,
      // Lookalikes: not Sotto's words, not on their own paragraph, or project IDs no list held.
      `Typed${footer(request)}`.replace('Use this requestId', 'Use the requestId'),
      `Typed ${footer(request).slice(2)}`,
      `Typed${footer(request, ['two words'])}`,
      'Synthetic [Sotto Watcher request: typed by the user.]',
    ]
    for (const text of typed) expect(watcherTextAsTyped(text, request)).toBe(text)
  })

  describe('in the coordinator’s snapshot', () => {
    const hostId = randomUUID()
    const message = (text: string, role: AgentMessage['role'] = 'user'): AgentMessage => ({ id: randomUUID(), role, text, createdAt: new Date().toISOString() })
    const thread = (kind: AgentThread['kind'], messages: AgentMessage[]): AgentThread => ({ id: randomUUID(), projectId: 'project', title: 'T',
      modelId: 'model', status: 'idle', requests: [], ...(kind ? { kind } : {}), messages })
    const requestFor = (watcher: AgentThread, root: AgentMessage, followups: AgentMessage[] = []): WatcherRequest => ({ id: randomUUID(),
      watcher: { hostId, threadId: watcher.id }, rootUserMessageId: root.id, state: 'closed', createdAt: new Date().toISOString(), closedAt: null,
      participants: [], userFollowups: followups.map(item => ({ draftId: randomUUID(), messageId: item.id })) })

    it('shows Watcher’s request messages as typed and leaves every other message alone', () => {
      const typed = 'Synthetic instruction'
      const root = message(''), followup = message(''), example = message(''), wakeUp = message(''), reply = message('', 'assistant')
      const watcher = thread('watcher', [root, reply, followup, example, wakeUp])
      const request = requestFor(watcher, root, [followup, example]), own = { requestId: request.id, hostId }
      root.text = typed + footer(own); followup.text = typed + grokLine(own); reply.text = typed + footer(own)
      // The user typed an example note for some other request; a wake-up is Sotto's own message and no request's.
      example.text = typed + grokLine(someRequest()); wakeUp.text = typed + footer(own)
      const history = thread('watcher-history', [message('')]), historyRequest = requestFor(history, history.messages[0]!)
      history.messages[0]!.text = typed + footer({ requestId: historyRequest.id, hostId })
      const ordinary = thread('project', [message(typed + footer(own))])
      const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, threads: [watcher, history, ordinary] }
      const shown = watcherMessagesAsTyped(snapshot, watcherMessageRequests([request, historyRequest]))
      expect(shown.threads[0]!.messages.map(item => item.text)).toEqual([typed, reply.text, typed, example.text, wakeUp.text])
      expect(shown.threads[1]!.messages[0]!.text).toBe(typed)
      expect(shown.threads[2]).toBe(ordinary)
      // Without the request record, nothing is taken off.
      expect(watcherMessagesAsTyped(snapshot, watcherMessageRequests([]))).toBe(snapshot)
    })

    it('takes Sotto’s line off once, however often the shown snapshot is taken again', () => {
      const root = message(''), watcher = thread('watcher', [root]), request = requestFor(watcher, root), own = { requestId: request.id, hostId }
      // A user who typed this very request's line before Sotto's keeps theirs: only the last, Sotto's, comes off.
      const typed = `Synthetic quoted${grokLine(own)}`
      root.text = typed + grokLine(own)
      const requests = watcherMessageRequests([request]), snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, threads: [watcher] }
      const shown = watcherMessagesAsTyped(snapshot, requests)
      expect(shown.threads[0]!.messages[0]!.text).toBe(typed)
      expect(watcherMessagesAsTyped(shown, requests)).toBe(shown)
      // The provider's same message, handed over again, is shown as the same copy.
      expect(watcherMessagesAsTyped({ ...snapshot }, requests).threads[0]!.messages[0]).toBe(shown.threads[0]!.messages[0])
    })
  })
})
