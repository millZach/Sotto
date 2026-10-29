// @vitest-environment node
// #1178 (Sol's second pass): a moving thread's fence lives in the coordinator's own record, so it holds across a restart
// whatever the move's record says, even a moves.json that does not parse at all.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { ThreadMoveService } from '../../../src/main/agents/threadMoves'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { THREAD_MOVE_WORDS } from '../../../src/shared/threadMoves'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { testCredentials } from '../../fixtures/testCredentials'

const roots: string[] = [], controls: AgentControl[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) { control.dispose(); await control.closed() }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function coordinator(root: string): Promise<AgentControl> {
  const control = createAgentControl({ directory: root, host: new E2EAgentHost(), credentials: await testCredentials(root, { mode: 'unavailable' }), reasoner: e2eAgentReasoner })
  controls.push(control)
  return control
}
/** Sotto starting again over `root`: the move's record is read first, then the coordinator's, then fences are settled. */
async function restart(root: string): Promise<{ control: AgentControl; moves: ThreadMoveService }> {
  const control = await coordinator(root)
  const moves = new ThreadMoveService(root, { control, workspace: { threadHandover: () => undefined, addContinuedIn: async () => undefined },
    branches: { forStart: async () => { throw new Error('No move steps here.') }, forget: async () => undefined } })
  await moves.load(); await control.start(); moves.settleFences()
  return { control, moves }
}
const send = (control: AgentControl, threadId: string) => control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Carry on here.' })

it('keeps a moving thread fenced across a restart when moves.json does not parse, and lifts the fence once a record that reads says the move is over', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-move-fences-')); roots.push(root)
  const first = await coordinator(root)
  await first.start()
  const fence = THREAD_MOVE_WORDS.fence('forge')
  await first.fenceForMove('moving-thread', fence)
  expect((await send(first, 'moving-thread')).error).toBe(fence)
  first.dispose(); await first.closed(); controls.splice(controls.indexOf(first), 1)

  await writeFile(join(root, 'moves.json'), '{"version": 1, "moves": [')
  const unread = await restart(root)
  expect((await send(unread.control, 'moving-thread')).error).toBe(fence)
  unread.moves.close(); unread.control.dispose(); await unread.control.closed(); controls.splice(controls.indexOf(unread.control), 1)

  // A record that reads and names no move under way for it: the fence was a lift that was not saved.
  await writeFile(join(root, 'moves.json'), JSON.stringify({ version: 1, moves: [] }))
  const read = await restart(root)
  expect(read.control.fencedForMove()).toEqual([])
  expect((await send(read.control, 'moving-thread')).error).not.toBe(fence)
  read.moves.close()
})

it('refuses at dispatch a send admitted before its thread was fenced for a move, and the provider hears nothing of it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-move-fences-')); roots.push(root)
  const host = new E2EAgentHost()
  const control = createAgentControl({ directory: root, host, credentials: await testCredentials(root, { mode: 'unavailable' }), reasoner: e2eAgentReasoner })
  controls.push(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  const fence = THREAD_MOVE_WORDS.fence('forge')
  // A settings change holds the thread's lane, so the send is admitted and waits behind it.
  host.event({ type: 'settings', text: 'hold', threadId: 'workshop' } as never)
  const configuring = control.commandShell({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high' })
  await new Promise(done => setTimeout(done, 20))
  const sending = control.commandShell({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Admitted before the move.' })
  await new Promise(done => setTimeout(done, 20))
  await control.fenceForMove('workshop', fence)
  host.event({ type: 'settings', text: 'release', threadId: 'workshop' } as never)
  await configuring
  expect((await sending).error).toBe(fence)
  expect((await host.snapshot()).threads.find(thread => thread.id === 'workshop')!.messages.some(message => message.text === 'Admitted before the move.')).toBe(false)
})
