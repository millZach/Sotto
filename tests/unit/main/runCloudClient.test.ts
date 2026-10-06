// @vitest-environment node
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunCloudClient } from '../../../src/main/tools/cloudIphone/runCloudClient'
import { start as startFakeRunCloud } from '../../fixtures/fakeRunCloud.mjs'

type FakeRunCloud = Awaited<ReturnType<typeof startFakeRunCloud>>

describe('RunCloudClient', () => {
  let fake: FakeRunCloud
  let client: RunCloudClient
  let directory: string

  beforeEach(async () => {
    fake = await startFakeRunCloud(0)
    client = new RunCloudClient(fake.key, { baseUrl: fake.url })
    directory = await mkdtemp(join(tmpdir(), 'run-cloud-client-'))
  })
  afterEach(async () => {
    await fake.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('checks the key with a bearer header and rejects a wrong one without naming it', async () => {
    await expect(client.checkKey()).resolves.toBeUndefined()
    const wrong = new RunCloudClient('rc_live_wrong', { baseUrl: fake.url })
    await expect(wrong.checkKey()).rejects.toThrow(/not one run\.cloud accepts/u)
    try { await wrong.checkKey() } catch (error) {
      expect(String((error as Error).message)).not.toContain('rc_live_wrong')
      expect(String((error as Error).message)).not.toContain(fake.key)
    }
  })

  it('never sends the key to a finalize address on another host', async () => {
    const path = join(directory, 'build.zip')
    await writeFile(path, 'a simulator build')
    const calls: { url: string; auth: string | undefined }[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
      if (url.endsWith('/run-cloud/assets/uploads')) return new Response(JSON.stringify({ upload: { url: 'https://storage.example/put', headers: {}, finalizeUrl: 'https://elsewhere.example/finalize' } }), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try { await expect(client.upload(path)).rejects.toThrow(/somewhere else/u) } finally { globalThis.fetch = real }
    expect(calls.some(call => call.url.startsWith('https://elsewhere.example'))).toBe(false)
    expect(calls.filter(call => call.auth !== undefined).every(call => call.url.startsWith(fake.url))).toBe(true)
  })

  it('uploads through the presigned flow, sending no Authorization header on the PUT', async () => {
    const path = join(directory, 'build.zip')
    await writeFile(path, 'a simulator build'.repeat(100))
    const assetId = await client.upload(path)
    expect(typeof assetId).toBe('string')
    expect(fake.assets.has(assetId)).toBe(true)
  })

  it('falls back to a buffered multipart upload when the presigned route answers 404', async () => {
    const path = join(directory, 'build.zip')
    await writeFile(path, 'a simulator build')
    fake.control({ noPresignOnce: true })
    const assetId = await client.upload(path)
    expect(fake.assets.has(assetId)).toBe(true)
  })

  it('deletes an uploaded asset', async () => {
    const path = join(directory, 'build.zip')
    await writeFile(path, 'a simulator build')
    const assetId = await client.upload(path)
    await client.deleteAsset(assetId)
    expect(fake.assets.has(assetId)).toBe(false)
  })

  it('starts a session and names the viewer URL and device', async () => {
    const started = await client.start({ assetId: 'asset-1', displayName: 'Sotto test' })
    expect(started.id).toBeTruthy()
    expect(started.viewerUrl).toBe(`${fake.url}/viewer/${started.id}`)
    expect(started.device).toContain('iPhone 16')
    expect(started.device).toContain('iOS 18.2')
  })

  it('turns 503 capacity into a plain message that charges nothing', async () => {
    fake.control({ capacityOnce: true })
    await expect(client.start({ assetId: 'asset-1', displayName: 'Sotto test' }))
      .rejects.toThrow(/no simulator free right now.*nothing was charged/iu)
  })

  it('gets, releases and keeps a session alive', async () => {
    const started = await client.start({ assetId: 'asset-1', displayName: 'Sotto test' })
    await expect(client.get(started.id)).resolves.toEqual({ status: 'active' })
    await expect(client.keepAlive(started.id)).resolves.toBeUndefined()
    await client.release(started.id)
    await expect(client.get(started.id)).resolves.toEqual({ status: 'released' })
  })

  it('sends a flat interaction body with a fresh requestId and surfaces a logical failure', async () => {
    const started = await client.start({ assetId: 'asset-1', displayName: 'Sotto test' })
    await client.interact(started.id, { kind: 'tap', x: 0.5, y: 0.5 })
    expect(fake.sessions.get(started.id)?.lastInteraction).toMatchObject({ action: 'tap', x: 0.5, y: 0.5 })
    expect(fake.sessions.get(started.id)?.lastInteraction?.requestId).toMatch(/^[A-Za-z0-9._:-]+$/u)
    fake.control({ interactionFailOnce: true })
    await expect(client.interact(started.id, { kind: 'key', key: 'Enter' })).rejects.toThrow('That interaction could not run.')
  })

  it('maps Sotto\'s own key and button names to run.cloud\'s before sending them', async () => {
    const started = await client.start({ assetId: 'asset-1', displayName: 'Sotto test' })
    await client.interact(started.id, { kind: 'key', key: 'ArrowUp' })
    expect(fake.sessions.get(started.id)?.lastInteraction).toMatchObject({ action: 'pressKey', key: 'arrowUp' })
    await client.interact(started.id, { kind: 'button', button: 'lock' })
    expect(fake.sessions.get(started.id)?.lastInteraction).toMatchObject({ action: 'pressButton', button: 'power' })
  })

  it('releases a simulator that started without a usable address, rather than leaving it running unseen', async () => {
    fake.control({ idOnlyOnce: true })
    await expect(client.start({ assetId: 'asset-1', displayName: 'Sotto test' })).rejects.toThrow(/released/u)
    expect([...fake.sessions.values()].some(session => session.status === 'released')).toBe(true)
  })

  it('says the upload may remain in the dashboard when finalize fails, without naming a status code', async () => {
    const path = join(directory, 'build.zip')
    await writeFile(path, 'a simulator build'.repeat(100))
    fake.control({ finalizeFailOnce: true })
    await expect(client.upload(path)).rejects.toThrow(/may remain in your run\.cloud dashboard/u)
  })

  it('never forwards run.cloud\'s raw message verbatim: scrubs addresses and credential-like tokens, and caps the length', async () => {
    fake.control({ echoErrorOnce: true })
    let message = ''
    try { await client.checkKey() } catch (error) { message = (error as Error).message }
    expect(message).not.toBe('')
    expect(message).not.toContain('internal.example')
    expect(message).not.toContain(fake.key)
    expect(message).toContain('an address')
    expect(message.length).toBeLessThanOrEqual(300)
  })

  it('opens a URL, takes a screenshot and reads the accessibility tree', async () => {
    const started = await client.start({ assetId: 'asset-1', displayName: 'Sotto test' })
    await client.openUrl(started.id, 'myapp://home')
    expect(fake.sessions.get(started.id)?.lastInteraction).toMatchObject({ url: 'myapp://home' })
    const png = await client.screenshot(started.id)
    expect(Buffer.isBuffer(png)).toBe(true)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const tree = await client.accessibility(started.id)
    expect(tree.screen).toEqual({ width: 393, height: 852 })
    expect(tree.roots[0]?.role).toBe('Application')
  })

  it('never includes a raw response body or the viewer URL in a mapped error', async () => {
    const wrong = new RunCloudClient('rc_live_wrong', { baseUrl: fake.url })
    await expect(wrong.start({ assetId: 'asset-1', displayName: 'x' })).rejects.toThrow(/not one run\.cloud accepts/u)
    try { await wrong.get('missing') } catch (error) {
      expect(String((error as Error).message)).not.toContain('rc_live_wrong')
    }
  })
})
