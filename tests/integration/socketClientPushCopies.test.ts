// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentState } from '../../src/shared/agents'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

/** A change on the host, which it pushes to every client as a shell. */
function change(): string {
  const workId = randomUUID()
  fixture.native.event({ type: 'background-work', threadId: 'workshop', text: '', status: 'idle',
    backgroundWork: [{ id: workId, label: 'Synthetic background work', type: 'command' }] })
  return workId
}
const carries = (state: AgentState, workId: string): boolean => state.host.threads.some(thread => thread.backgroundWork?.some(work => work.id === workId))

// The desktop's client of a paired host handles a shell push up to twenty times a second while anything on the host
// streams. Each push made a whole structured clone of the shell, with every held detail laid over it, for a listener that
// reads a few fields, and read the model catalog it already held into a new array again (#996).
describe('what a shell push costs the desktop', () => {
  it('hands its listeners each push without copying the shell', async () => {
    const { client } = await fixture.pair('Desktop')
    await expect.poll(() => client.view().host.threads.length).toBeGreaterThan(0)
    const heard: AgentState[] = []
    const off = client.subscribe(state => { heard.push(state) })
    const shells = vi.spyOn(SocketHostService.prototype, 'shell')
    const states = vi.spyOn(SocketHostService.prototype, 'state')
    try {
      const workId = change()
      await expect.poll(() => heard.some(state => carries(state, workId))).toBe(true)
      expect(shells).not.toHaveBeenCalled()
      expect(states).not.toHaveBeenCalled()
    } finally { off(); shells.mockRestore(); states.mockRestore() }
  })

  it('reads a model catalog it already holds once, and hands every later push the same frozen catalog', async () => {
    const { client } = await fixture.pair('Desktop')
    await expect.poll(() => client.view().host.threads.length).toBeGreaterThan(0)
    const heard: AgentState[] = []
    const off = client.subscribe(state => { heard.push(state) })
    try {
      const first = change()
      await expect.poll(() => heard.some(state => carries(state, first))).toBe(true)
      const second = change()
      await expect.poll(() => heard.some(state => carries(state, second))).toBe(true)
      const models = heard.find(state => carries(state, first))!.host.models
      const later = heard.find(state => carries(state, second))!.host.models
      expect(models.length).toBeGreaterThan(0)
      expect(later).toBe(models)
      expect(Object.isFrozen(later)).toBe(true)
      // A copy a caller asks for is still its own to change.
      expect(Object.isFrozen(client.shell().host.models)).toBe(false)
    } finally { off() }
  })
})
