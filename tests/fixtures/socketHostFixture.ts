// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { startFixtureHeadlessHost as startHeadlessHost } from './desktopHostStack'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import { heldProvidersOf } from '../../src/shared/heldProviders'
import { owlFeaturesForTrack } from '../../src/shared/owlFeatures'
import { getReleaseTrack } from '../../src/shared/releaseTrack'
import { version as packageVersion } from '../../package.json'

/**
 * What a desktop of the fixture host's own version holds: the host runs the source version, and so does this desktop. A
 * client built without a held set holds Muse and OpenCode, as a desktop before 0.1.40 does, and refuses a command that
 * may name one of them. The fakes all share their native IDs, so an unscoped one names a Muse project as well.
 */
export const SAME_VERSION_HELD = heldProvidersOf(owlFeaturesForTrack(getReleaseTrack(packageVersion)))

export function useSocketHostFixture() {
  let root: string

  let host: Awaited<ReturnType<typeof startHeadlessHost>>

  let clients: SocketHostService[]

  let url: string

  let native: E2EAgentHost

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-socket-'))
    native = new E2EAgentHost()
    host = await startHeadlessHost({ dataDirectory: root, port: 0, providers: { codex: native } })
    url = 'http://127.0.0.1:' + host.descriptor!.port; clients = []
  })

  afterEach(async () => { await Promise.all(clients.map(client => client.close())); await host?.close(); if (root && dirname(root) === tmpdir() && root.includes('sotto-socket-')) await rm(root, { recursive: true, force: true }) })

  async function pair(name = 'Socket test', onPushError?: (message: string) => void) {
    const result = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, name)
    const client = new SocketHostService({ url, token: result.token, expectedHostId: result.hostId, heldProviders: SAME_VERSION_HELD, ...(onPushError ? { onPushError } : {}) }); clients.push(client)
    await client.connect(); return { client, result }
  }

  return {
    get clients() { return clients },
    set clients(value: typeof clients) { clients = value },
    get host() { return host },
    set host(value: typeof host) { host = value },
    get native() { return native },
    set native(value: typeof native) { native = value },
    pair,
    get root() { return root },
    set root(value: typeof root) { root = value },
    get url() { return url },
    set url(value: typeof url) { url = value },
  }
}
