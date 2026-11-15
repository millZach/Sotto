// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { FileDownloads } from '../../src/main/files/downloads'
import { FILES_DOWNLOAD_PART_BYTES } from '../../src/shared/files'
import { startFixtureHeadlessHost as startHeadlessHost } from '../fixtures/desktopHostStack'
import { SAME_VERSION_HELD } from '../fixtures/socketHostFixture'

let root: string, host: Awaited<ReturnType<typeof startHeadlessHost>>, clients: SocketHostService[]

/** A host whose `reveal-linked-files` Owl answer is `on`, and a desktop paired to it, with what the host's hello offered it. */
async function paired(on: boolean): Promise<{ client: SocketHostService; features: readonly string[] }> {
  const native = new E2EAgentHost()
  host = await startHeadlessHost({ dataDirectory: root, port: 0, providers: { codex: native }, owlFeatures: { 'reveal-linked-files': on } })
  await native.initializeWorkingFolders(join(root, 'workspaces'))
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const result = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Linked files test')
  const client = new SocketHostService({ url, token: result.token, expectedHostId: result.hostId, heldProviders: SAME_VERSION_HELD }); clients.push(client)
  return { client, features: (await client.connect()).features }
}
async function thread(client: SocketHostService): Promise<string> {
  await client.command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
  await client.command({ type: 'connect', provider: 'codex' })
  const threadId = client.shell().host.threads[0]!.id
  await client.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic prompt' })
  return threadId
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-linked-socket-')); clients = [] })
afterEach(async () => {
  await Promise.all(clients.map(client => client.close())); await host?.close()
  if (root && dirname(root) === tmpdir() && root.includes('sotto-linked-socket-')) await rm(root, { recursive: true, force: true })
})

describe('a linked file read from a paired host over its socket (ADR-0120, November 12 amendment)', () => {
  it('finds a file in the thread\'s folder and one outside it, previews it, and saves it to this computer part by part', async () => {
    const { client, features } = await paired(true)
    expect(features).toContain('thread-linked-files')
    const folder = join(root, 'workspaces', 'project'), outside = join(root, 'exports')
    await mkdir(join(folder, 'out'), { recursive: true }); await mkdir(outside)
    // Larger than one part, so the download asks twice and the second part must match the first's file.
    const report = Buffer.alloc(FILES_DOWNLOAD_PART_BYTES + 4096)
    for (let index = 0; index < report.length; index += 1021) report[index] = index % 253
    await writeFile(join(folder, 'out', 'q3-report.pdf'), report); await writeFile(join(outside, 'sales.csv'), 'month,revenue\n2026-07,418200\n')
    const threadId = await thread(client)

    // Where each is: Files' own tree holds the first, and the second is shown alone.
    const listing = await client.threadFiles({ threadId, path: '' })
    if (!listing.ok) throw new Error(listing.error.message)
    await expect(client.threadLinkedFile({ threadId, want: 'place', path: join(folder, 'out', 'q3-report.pdf') })).resolves.toEqual({ ok: true, value: { is: 'place', name: 'q3-report.pdf', kind: 'file', size: report.length, inside: { workspace: listing.value.workspace, path: 'out/q3-report.pdf' } } })
    await expect(client.threadLinkedFile({ threadId, want: 'place', path: 'out' })).resolves.toMatchObject({ ok: true, value: { kind: 'directory', inside: { path: 'out' } } })
    await expect(client.threadLinkedFile({ threadId, want: 'place', path: join(outside, 'sales.csv') })).resolves.toEqual({ ok: true, value: { is: 'place', name: 'sales.csv', kind: 'file', size: 29, inside: null } })
    await expect(client.threadLinkedFile({ threadId, want: 'preview', path: join(outside, 'sales.csv') })).resolves.toMatchObject({ ok: true, value: { is: 'preview', content: { kind: 'text', text: 'month,revenue\n2026-07,418200\n' } } })
    // A refusal is an answer, as Files' own are.
    await expect(client.threadLinkedFile({ threadId, want: 'place', path: join(outside, 'missing.csv') })).resolves.toMatchObject({ ok: false, error: { code: 'path-unavailable' } })
    await expect(client.threadLinkedFile({ threadId, want: 'place', path: '../../exports/sales.csv' })).resolves.toMatchObject({ ok: false, error: { code: 'path-outside-workspace' } })
    await expect(client.threadLinkedFile({ threadId: 'no-such-thread', want: 'place', path: 'out' })).resolves.toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    // A network share is not a request the host reads.
    await expect(client.threadLinkedFile({ threadId, want: 'place', path: '//evil.example/share/a' })).rejects.toThrow()

    // The download, as main runs it: every part over the socket into a Downloads folder on this side.
    const downloads = join(root, 'downloads'), progress: number[] = []
    const saving = new FileDownloads({ part: request => client.threadLinkedFile(request), folder: () => downloads, progress: event => progress.push(event.received) })
    const saved = await saving.download({ threadId, path: 'out/q3-report.pdf' })
    expect(saved).toMatchObject({ ok: true, value: { name: 'q3-report.pdf', size: report.length } })
    expect(progress).toEqual([FILES_DOWNLOAD_PART_BYTES, report.length])
    expect((await readFile(join(downloads, 'q3-report.pdf'))).equals(report)).toBe(true)
    expect(await readdir(downloads)).toEqual(['q3-report.pdf'])
  }, 60_000)

  it('offers none of it while the host\'s Owl answer is off, and the desktop names the version instead of asking', async () => {
    const { client, features } = await paired(false)
    expect(features).not.toContain('thread-linked-files')
    await expect(client.threadLinkedFile({ threadId: 'thread', want: 'place', path: '/home/me/a.pdf' })).rejects.toMatchObject({ code: 'version_mismatch' })
  })
})
