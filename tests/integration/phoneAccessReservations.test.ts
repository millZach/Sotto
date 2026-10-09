// @vitest-environment node
import { writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'

import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { serveTarget } from '../../src/main/phones/tailscale'

import { root, fakeTailscale, fakeServer, create, record } from '../fixtures/phoneAccessFixture'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
async function expectReserved(port: number): Promise<void> {
  const server = createServer()
  await expect(new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.on('error', reject)
    socket.on('close', () => resolve())
  })
}

it.each([false, true])('reserves pending cleanup at restart with phone access set to %s', async enabled => {
  const port = await freePort()
  await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port, mapped: true }))
  const fake = fakeTailscale({ other: serveTarget(port) }), server = fakeServer()
  vi.mocked(fake.tailscale.unserve).mockResolvedValue(false)
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer }, { phoneAccess: enabled, phoneAccessName: '' })
  try {
    await access.start()
    expect(access.get().phase).toBe('cleanup-failed')
    expect(server.started).toEqual([])
    await expectReserved(port)
    settings.phoneAccess = false
    vi.mocked(fake.tailscale.unserve).mockResolvedValue(true)
    await access.command({ type: 'retry' })
    expect(access.get().phase).toBe('off')
    const rebound = createServer()
    await new Promise<void>(resolve => rebound.listen(port, '127.0.0.1', resolve))
    await new Promise<void>(resolve => rebound.close(() => resolve()))
  } finally { await access.close() }
})

it('preserves a valid cleanup record until read access returns', async () => {
  const port = await freePort()
  await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port, mapped: true }))
  const fake = fakeTailscale({ other: serveTarget(port) })
  const { access } = create({ tailscale: fake.tailscale }, { phoneAccess: false, phoneAccessName: '' })
  const peek = vi.spyOn(AtomicJsonStore.prototype, 'peek').mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EACCES' }))
  // Writes remain available while reads are refused.
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write')
  try {
    await access.start()
    await access.command({ type: 'retry' })
    expect(access.get()).toMatchObject({ phase: 'cleanup-failed', serve: { reason: 'cleanup-record' } })
    expect(await record()).toEqual({ port, mapped: true })
    expect(write.mock.calls.some(([value]) => typeof value === 'object' && value !== null && 'mapped' in value)).toBe(false)
    expect(fake.tailscale.unserve).not.toHaveBeenCalled()
    peek.mockRestore()
    await access.command({ type: 'retry' })
    expect(fake.tailscale.unserve).toHaveBeenCalledOnce()
    expect(access.get().phase).toBe('off')
    expect(await record()).toEqual({ port, mapped: false })
  } finally { peek.mockRestore(); write.mockRestore(); await access.close() }
})
