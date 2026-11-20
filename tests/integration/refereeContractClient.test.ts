// @vitest-environment node
// The adapter contract's client across the socket (`tests/referee/socketAgentHost.ts`) reads a connection's frames in the
// order they crossed. A host writes a command's answer and the push after it back to back, and one read off the socket can
// hold both; each case here hands the client exactly that, on a socket the test writes to itself.
import { expect, it } from 'vitest'
import { SocketAgentHost } from '../referee/socketAgentHost'
import type { Crossing, Socket } from '../referee/wire'

type Json = Record<string, unknown>

/** A socket whose host is the test: what the client sends is kept, and `read` delivers frames as one read would. */
function scriptedSocket(): { socket: Socket; sent: Json[]; read: (...frames: Json[]) => void } {
  const crossings: Crossing[] = []
  const listeners = new Set<() => void>()
  const sent: Json[] = []
  const socket: Socket = {
    crossings, extensions: undefined,
    send: frame => { crossings.push({ dir: 'out', frame }); sent.push(frame) },
    onArrival: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    close: () => undefined,
  }
  // `SocketFrames` hands over every message in a read before anything awaited runs, which is what this does.
  const read = (...frames: Json[]): void => { for (const frame of frames) { crossings.push({ dir: 'in', frame }); for (const listener of listeners) listener() } }
  return { socket, sent, read }
}

const MODELS = [{ id: 'referee-model', label: 'Referee model' }]
const thread = (status: string): Json => ({ id: 'thread-1', projectId: 'project-1', modelId: 'referee-model', status, requests: [] })
const shell = (host: Json, top: Json = {}): Json => ({ ...top, host: { projects: [], threads: [], ...host } })
const answer = (id: string, result: Json): Json => ({ v: 1, id, ok: true, result })
const push = (state: Json): Json => ({ v: 1, event: 'shell', state })

it('holds the catalog an answer carried before it reads the push that names it only by revision (#2721)', async () => {
  const { socket, sent, read } = scriptedSocket()
  const opening = SocketAgentHost.onSocket(socket, 'session', 'claude')
  const hello = sent.at(-1)!
  expect(hello.op).toBe('hello')
  // The host counts a catalog as sent once the answer carrying it is written, so the push after it leaves it out: first
  // the hello's, then a changed one a command's answer carries, as connecting a provider's does.
  read(answer(String(hello.id), { shell: shell({ modelsRevision: 1, models: [] }) }),
    push(shell({ modelsRevision: 1, threads: [thread('idle')] })))
  const host = await opening
  expect((await host.snapshot()).threads.map(item => item.status)).toEqual(['idle'])
  const stopping = host.execute({ type: 'interrupt', commandId: 'command-1', threadId: 'thread-1' })
  const command = sent.at(-1)!
  read(answer(String(command.id), shell({ modelsRevision: 2, models: MODELS, threads: [thread('idle')] })),
    push(shell({ modelsRevision: 2, threads: [thread('idle')] })))
  await stopping
  expect((await host.snapshot()).models).toEqual(MODELS)
})

it('shows the push that crossed after a command answer, not the answer (#2723)', async () => {
  const { socket, sent, read } = scriptedSocket()
  const opening = SocketAgentHost.onSocket(socket, 'session', 'claude')
  read(answer(String(sent.at(-1)!.id), { shell: shell({ threads: [thread('idle')] }) }))
  const host = await opening
  const stopping = host.execute({ type: 'interrupt', commandId: 'command-1', threadId: 'thread-1' })
  const command = sent.at(-1)!
  expect(command.op).toBe('command')
  // The answer is the state as the command returned; the push written after it shows the turn already ended.
  read(answer(String(command.id), shell({ threads: [thread('running')] })), push(shell({ threads: [thread('idle')] })))
  await stopping
  expect((await host.snapshot()).threads.map(item => item.status)).toEqual(['idle'])
})

it('finishes a send whose delivery and turn show only in the push that crossed after its answer (#2723)', async () => {
  const { socket, sent, read } = scriptedSocket()
  const opening = SocketAgentHost.onSocket(socket, 'session', 'claude')
  read(answer(String(sent.at(-1)!.id), { shell: shell({ threads: [thread('idle')] }) }))
  const host = await opening
  const sending = host.execute({ type: 'send', commandId: 'command-1', threadId: 'thread-1', messageId: 'contract-message', text: 'Synthetic prompt' })
  // Nothing to stage, so the send goes at once.
  const send = sent.at(-1)!
  const { draftId } = send.command as { draftId: string }
  expect(send.command).toMatchObject({ type: 'manual-send', threadId: 'thread-1' })
  // The answer shows the send still being written; the push after it, and no other, shows it taken and the turn running.
  read(answer(String(send.id), shell({ threads: [thread('idle')] }, { deliveries: [{ threadId: 'thread-1', draftId, status: 'submitting' }] })),
    push(shell({ threads: [{ ...thread('running'), lastUserMessageId: 'host-message', lastTurn: { id: 'host-message', status: 'running' } }] },
      { deliveries: [{ threadId: 'thread-1', draftId, status: 'accepted', messageId: 'host-message', providerLatencyMs: 5 }] })))
  await expect(sending).resolves.toEqual({ accepted: true })
  expect((await host.snapshot()).threads.map(item => [item.status, item.lastUserMessageId])).toEqual([['running', 'contract-message']])
})
