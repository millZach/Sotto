// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SocketFrames } from '../../src/host/socketFrames'
import { LocalHostService } from '../../src/main/agents/hostService'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

describe('what a publish costs with several paired phones', () => {
  // Every publish read the host's whole shell once per connected phone, and each read copies the whole coordinator
  // state. One read serves every phone: none of them edits what it is handed.
  it('reads the host\'s shell once per publish, however many phones are connected', async () => {
    const phones = await Promise.all(['One', 'Two', 'Three'].map(name => fixture.pair(name)))
    for (const { client } of phones) await expect.poll(() => client.shell().host.threads.length).toBeGreaterThan(0)
    const workId = randomUUID()
    const shells = vi.spyOn(LocalHostService.prototype, 'shell')
    // A change can take more than one publish; each publish sends every phone a shell frame and reads the shell once.
    const sent = vi.spyOn(SocketFrames.prototype, 'sendText')
    fixture.native.event({ type: 'background-work', threadId: 'workshop', text: '', status: 'idle',
      backgroundWork: [{ id: workId, label: 'Synthetic background work', type: 'command' }] })
    for (const { client } of phones) {
      await expect.poll(() => client.shell().host.threads.some(thread => thread.backgroundWork?.some(work => work.id === workId))).toBe(true)
    }
    const reads = shells.mock.calls.length
    const shellFrames = sent.mock.calls.filter(([text]) => typeof text === 'string' && text.startsWith('{"v":1,"event":"shell"')).length
    shells.mockRestore(); sent.mockRestore()
    expect(shellFrames).toBeGreaterThanOrEqual(phones.length)
    expect(reads * phones.length).toBeLessThanOrEqual(shellFrames)
  })
})
