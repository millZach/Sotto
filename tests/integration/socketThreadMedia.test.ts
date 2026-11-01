// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { SAME_VERSION_HELD } from '../fixtures/socketHostFixture'

const roots: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A headless host whose own Owl answer for pictures in threads is `on`, and a desktop paired to it. */
async function hostWithMedia(on: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-thread-media-')); roots.push(root)
  const host = await startFixtureHeadlessHost({ dataDirectory: root, port: 0, owlFeatures: { 'inline-media': on } })
  closers.push(() => host.close())
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const result = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Thread media')
  const client = new SocketHostService({ url, token: result.token, expectedHostId: result.hostId, heldProviders: SAME_VERSION_HELD })
  closers.push(() => client.close())
  await client.connect()
  return { host, client }
}

describe('an agent\'s pictures on a remote host (ADR-0170)', () => {
  it('lists thread-media only on its Owl answer, and answers nothing for a handle no record carries', async () => {
    const on = await hostWithMedia(true)
    expect(on.host.descriptor!.features).toContain('thread-media')
    await expect(on.client.threadMedia({ threadId: 'no-such-thread', activityId: 'a', mediaId: 'm0' })).resolves.toBeNull()
    const off = await hostWithMedia(false)
    expect(off.host.descriptor!.features).not.toContain('thread-media')
    // A desktop never asks a host that does not list it.
    await expect(off.client.threadMedia({ threadId: 'no-such-thread', activityId: 'a', mediaId: 'm0' })).resolves.toBeNull()
  }, 60_000)
})
