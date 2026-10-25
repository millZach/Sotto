// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import type { HostAttachmentFile, HostAttachmentFileRequest } from '../../src/shared/hostProtocol'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const PART: NonNullable<HostAttachmentFile> = { name: 'quarterly-report.pdf', mimeType: 'application/pdf', sizeBytes: 15, digest: 'b'.repeat(64),
  part: 0, parts: 1, data: Buffer.from('%PDF-1.7 report').toString('base64') }

/** The fixture host's own service, with attached files on or off as its Owl answer would have them. */
function filesHost(on: boolean, read: (request: HostAttachmentFileRequest) => Promise<HostAttachmentFile>, provider: (threadId: string) => 'codex' | 'opencode' = () => 'codex'): HostService {
  const base = fixture.host.service
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener),
    threadProvider: provider, stageAttachment: image => base.stageAttachment!(image), attachmentFile: read,
    ...on ? { supportsFileStaging: true } : {},
  } as HostService
}

async function phoneOn(service: HostService) {
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
  const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  return { server, phone }
}
const request = (part = 0, threadId = 'workshop') => ({ op: 'attachment-file', request: { threadId, messageId: 'message', attachmentId: 'file', part } })

describe('a sent file’s bytes for the iPhone’s Quick Look (ADR-0131, October 25 amendment)', () => {
  it('is offered with file staging and answers a part of a file a thread the phone reads carries', async () => {
    const asked: HostAttachmentFileRequest[] = []
    const { server, phone } = await phoneOn(filesHost(true, async read => { asked.push(read); return PART }))
    try {
      expect(server.descriptor.features).toEqual(expect.arrayContaining(['file-staging', 'attachment-files']))
      await phone.call('hello', { op: 'hello' })
      expect(await phone.call('file', request())).toMatchObject({ ok: true, result: PART })
      expect(asked).toEqual([request().request])
      // A part number past what a 25 MB file can have is not a request at all.
      expect(await phone.call('past', request(4))).toMatchObject({ ok: false })
      expect(asked).toHaveLength(1)
    } finally { phone.frames.close(); await server.close() }
  })

  it('reads no thread the phone is not sent', async () => {
    const asked: string[] = []
    // A thread the client is not sent, here an OpenCode thread to a client that does not accept it (#1107), is refused
    // before any request that names it is read, as every `request.threadId` is.
    const { server, phone } = await phoneOn(filesHost(true, async read => { asked.push(read.threadId); return PART },
      threadId => threadId === 'held' ? 'opencode' : 'codex'))
    try {
      await phone.call('hello', { op: 'hello' })
      expect(await phone.call('hidden', request(0, 'held'))).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(asked).toEqual([])
      expect(await phone.call('shown', request())).toMatchObject({ ok: true, result: PART })
      expect(asked).toEqual(['workshop'])
    } finally { phone.frames.close(); await server.close() }
  })

  it('is neither offered nor answered where the host’s own answer is off', async () => {
    const asked: string[] = []
    const { server, phone } = await phoneOn(filesHost(false, async read => { asked.push(read.threadId); return PART }))
    try {
      expect(server.descriptor.features).not.toContain('attachment-files')
      await phone.call('hello', { op: 'hello' })
      expect(await phone.call('file', request())).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(asked).toEqual([])
    } finally { phone.frames.close(); await server.close() }
  })
})
