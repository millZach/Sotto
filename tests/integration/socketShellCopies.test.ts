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

  // A phone whose socket is backed up is owed the shell and reads it afresh when it drains, so a publish to phones that
  // are all backed up has nothing to send and reads nothing.
  it('reads nothing for a publish when every phone is backed up', async () => {
    const phones = await Promise.all(['One', 'Two'].map(name => fixture.pair(name)))
    for (const { client } of phones) await expect.poll(() => client.shell().host.threads.length).toBeGreaterThan(0)
    let drain!: () => void
    const draining = new Promise<void>(resolve => { drain = resolve })
    const backlogged = vi.spyOn(SocketFrames.prototype, 'backlogged', 'get').mockReturnValue(true)
    const drained = vi.spyOn(SocketFrames.prototype, 'drained').mockReturnValue(draining)
    const shells = vi.spyOn(LocalHostService.prototype, 'shell')
    try {
      fixture.native.event({ type: 'background-work', threadId: 'workshop', text: '', status: 'idle',
        backgroundWork: [{ id: randomUUID(), label: 'Synthetic background work', type: 'command' }] })
      // Each backed-up phone waits for its socket to drain once, and the publish is over.
      await expect.poll(() => drained.mock.calls.length).toBe(phones.length)
      expect(shells.mock.calls.length).toBe(0)
    } finally { backlogged.mockRestore(); drained.mockRestore(); shells.mockRestore(); drain() }
  })
})
