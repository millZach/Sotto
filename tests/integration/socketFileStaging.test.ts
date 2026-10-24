// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { HOST_CANNOT_STAGE_FILES } from '../../src/shared/agents'
import { FILE_UPLOAD_INCOMPLETE } from '../../src/host/fileUploads'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { SAME_VERSION_HELD } from '../fixtures/socketHostFixture'
import { PIXEL_PNG } from '../fixtures/stagedImages'

const roots: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A headless host whose own Owl answer for attaching any file is `on`, and a desktop paired to it. */
async function hostWithFiles(on: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-file-staging-')); roots.push(root)
  const host = await startFixtureHeadlessHost({ dataDirectory: root, port: 0, owlFeatures: { 'attach-any-file': on } })
  closers.push(() => host.close())
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const result = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'File staging')
  const client = new SocketHostService({ url, token: result.token, expectedHostId: result.hostId, heldProviders: SAME_VERSION_HELD })
  closers.push(() => client.close())
  await client.connect()
  return { root, host, client, url, token: result.token, hostId: result.hostId }
}

describe('attached files on a remote host (ADR-0131)', () => {
  it('stages a 20 MiB file over the socket in parts, kept on the host with its exact bytes', async () => {
    const { root, host, client } = await hostWithFiles(true)
    expect(host.descriptor!.features).toContain('file-staging')
    const bytes = Buffer.alloc(20 * 1024 * 1024)
    for (let index = 0; index < bytes.length; index += 4096) bytes[index] = index % 251
    const handle = await client.stageAttachment({ name: 'build-output.zip', mimeType: 'application/zip', bytes })
    expect(handle).toMatchObject({ name: 'build-output.zip', mimeType: 'application/zip', sizeBytes: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex') })
    const kept = await readFile(join(root, 'attachments', `${handle.digest}.bin`))
    expect(kept.equals(bytes)).toBe(true)
    // A file draws no chip, so its host hands none of its bytes back.
    await expect(client.attachmentContent(handle.digest)).resolves.toBeNull()
    // Images still go in one frame by `stage-attachment`.
    await expect(client.stageAttachment({ name: 'pixel.png', mimeType: 'image/png', bytes: PIXEL_PNG })).resolves.toMatchObject({ mimeType: 'image/png' })
  }, 60_000)

  it('holds one upload per paired client across its sockets, a new one replacing the old', async () => {
    const { host, client, url, token, hostId } = await hostWithFiles(true)
    // A second socket of the same paired client.
    const second = new SocketHostService({ url, token, expectedHostId: hostId, heldProviders: SAME_VERSION_HELD })
    closers.push(() => second.close()); await second.connect()
    type Part = { uploadId: string; index: number; count: number; name: string; mimeType: string; sizeBytes: number; digest: string; data: string }
    const call = (service: SocketHostService, part: Part) => (service as unknown as { call(operation: { op: 'stage-file-part'; part: Part }): Promise<unknown> }).call({ op: 'stage-file-part', part })
    const parts = (name: string, text: string): [Part, Part] => {
      const uploadId = randomUUID(); const bytes = Buffer.from(text); const half = Math.ceil(bytes.length / 2)
      const whole = { uploadId, count: 2, name: `${name}.txt`, mimeType: 'text/plain', sizeBytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') }
      return [{ ...whole, index: 0, data: bytes.subarray(0, half).toString('base64') }, { ...whole, index: 1, data: bytes.subarray(half).toString('base64') }]
    }
    const first = parts('first-upload', 'The first file, begun on one socket')
    const next = parts('second-upload', 'The second file, begun on the other socket')
    await expect(call(client, first[0])).resolves.toBeNull()
    // The same client starting another upload on its other socket replaces the first, which can no longer finish.
    await expect(call(second, next[0])).resolves.toBeNull()
    await expect(call(client, first[1])).rejects.toThrow(FILE_UPLOAD_INCOMPLETE)
    // A part may come on any of the client's sockets, and closing one leaves the upload to the other.
    await client.close()
    await expect(call(second, next[1])).resolves.toMatchObject({ name: 'second-upload.txt', sizeBytes: next[0].sizeBytes })
    expect(host.descriptor!.features).toContain('file-staging')
  })

  it('asks a host whose own answer is off to keep no file, and says to update it', async () => {
    const { root, host, client } = await hostWithFiles(false)
    expect(host.descriptor!.features).not.toContain('file-staging')
    await expect(client.stageAttachment({ name: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('Notes') })).rejects.toThrow(HOST_CANNOT_STAGE_FILES)
    await expect(readdir(join(root, 'attachments'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(client.stageAttachment({ name: 'pixel.png', mimeType: 'image/png', bytes: PIXEL_PNG })).resolves.toMatchObject({ mimeType: 'image/png' })
  })
})
