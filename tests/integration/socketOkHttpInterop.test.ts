// @vitest-environment node
/**
 * A phone on OkHttp against a host that compresses for phones (#2394). OkHttp is what the Android client connects with
 * (ADR-0059), and it is a `permessage-deflate` implementation Sotto did not write: it offers the extension by itself,
 * and compresses every message of 1 KiB or more that it sends. `tests/fixtures/OkHttpPhone.java` says hello, reads a
 * long thread and stages two photos on one connection, and this holds that each side read what the other sent.
 *
 * It needs a Java and OkHttp's jars, which the repository does not carry, so it runs only when told where they are:
 *
 *   SOTTO_OKHTTP_CLASSPATH='<folder of okhttp-4.12.0.jar, okio-jvm-3.6.0.jar and kotlin-stdlib-1.9.10.jar>/*' \
 *     npx vitest run tests/integration/socketOkHttpInterop.test.ts --maxWorkers=1
 *
 * `SOTTO_JAVA` names the `java` to run when the one on `PATH` is not it. The jars are on Maven Central under
 * `com/squareup/okhttp3/okhttp`, `com/squareup/okio/okio-jvm` and `org/jetbrains/kotlin/kotlin-stdlib`.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { DEFLATE_RESPONSE, DEFLATE_SYNC_MAX_BYTES, SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import type { AgentAttachmentHandle, AgentThreadDetail } from '../../src/shared/agents'
import { PHONES_ONLY_TAILNET, serviceWithLongThread } from '../fixtures/longThreadService'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const CLASSPATH = process.env.SOTTO_OKHTTP_CLASSPATH
const fixture = useSocketHostFixture()
const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

it.skipIf(!CLASSPATH)('reads what an OkHttp phone sends compressed, two photos on one connection, and OkHttp reads what the host compresses', async () => {
  const long: AgentThreadDetail = { threadId: 'long', revision: 1, messages: Array.from({ length: 4 }, (_, index) => ({ id: 'message-' + index, role: 'assistant' as const,
    createdAt: '2026-11-10T00:00:00.000Z', text: Array.from({ length: 3000 }, (_, line) => `src/host/socketServer.ts:${line} ok ${index}`).join('\n') })) }
  const staged: { size: number; hash: string }[] = []
  const host = fixture.host
  // Keeps nothing: the photo's size and hash are what the check reads.
  const service = serviceWithLongThread(host.service, long, { stageAttachment: image => {
    staged.push({ size: image.bytes.byteLength, hash: sha256(image.bytes) })
    return Promise.resolve({ id: 'photo-' + staged.length, name: image.name, mimeType: image.mimeType, sizeBytes: image.bytes.byteLength, digest: sha256(image.bytes) } as AgentAttachmentHandle)
  } })
  // Shaped like a headless host's tailnet listener with no desktop recorded, so this client is a phone.
  const phones = await startSocketServer({ service, pairing: host.pairing, admin: false, compressPhones: true, tailnet: PHONES_ONLY_TAILNET })
  const inflated = vi.spyOn(SocketFrames.prototype as unknown as { inflate(payload: Buffer): Buffer }, 'inflate')
  const sent = vi.spyOn(SocketFrames.prototype, 'sendText')
  const written = vi.spyOn(SocketFrames.prototype as unknown as { frame(opcode: number, data: Buffer, compressed: boolean): boolean }, 'frame')
  try {
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'OkHttp phone')
    const session = host.pairing.signSession(paired.clientId)
    const ran = await promisify(execFile)(process.env.SOTTO_JAVA ?? 'java', ['-cp', CLASSPATH!, resolve('tests/fixtures/OkHttpPhone.java'), String(phones.descriptor.port), session], { timeout: 90_000 })
    const lines = ran.stdout.trim().split('\n').map(line => line.trim().split(' '))
    const of = (kind: string): string[][] => lines.filter(line => line[0] === kind).map(line => line.slice(1))
    expect(of('FAILURE')).toEqual([])
    // OkHttp offered the extension unasked and took the host's answer.
    expect(of('EXTENSIONS')).toEqual([DEFLATE_RESPONSE.split(' ')])
    // What OkHttp read is what the host sent, the hello and the long thread among it, both compressed on the wire.
    const read = new Map(of('MESSAGE').map(([id, bytes, hash]) => [id!, { bytes: Number(bytes), hash }]))
    const texts = sent.mock.calls.map(([text]) => ({ bytes: Buffer.byteLength(text), hash: sha256(text) }))
    for (const id of ['hello', 'long', 'photo-1', 'photo-2']) expect(texts, id).toContainEqual(read.get(id))
    expect(read.get('long')!.bytes).toBeGreaterThan(DEFLATE_SYNC_MAX_BYTES)
    const compressed = written.mock.calls.filter(([opcode, , packed]) => opcode === 1 && packed).map(([, data]) => data.length)
    expect(compressed.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...compressed)).toBeLessThan(read.get('long')!.bytes / 4)
    // What the host kept is what OkHttp sent: two photos, each arriving as a compressed message the host inflated whole.
    expect(staged).toEqual(of('PHOTO').map(([, bytes, hash]) => ({ size: Number(bytes), hash })))
    expect(staged).toHaveLength(2)
    const photos = inflated.mock.results.filter(result => result.type === 'return' && (result.value as Buffer).length > staged[0]!.size)
    expect(photos).toHaveLength(2)
    expect(of('CLOSED')).toEqual([['1000']])
  } finally { inflated.mockRestore(); sent.mockRestore(); written.mockRestore(); await phones.close() }
}, 120_000)
