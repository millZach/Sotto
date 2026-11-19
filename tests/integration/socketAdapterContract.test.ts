// @vitest-environment node
// The adapter contract across the socket (docs/plans/2026-11-14-rust-native-port.md, Stage 0 item 3): every case of
// `adapterContract.ts` run against a host started by its command line, reached only as a paired client reaches it, while
// each provider's fake is driven through its files. The host is the Node referee host unless SOTTO_REFEREE_HOST names
// another, as for the replays; docs/verification/2026-11-19-referee-harness.md says how, and names each case that cannot
// cross and why.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, vi } from 'vitest'
import { buildNodeRefereeHost, namedRefereeHost } from '../referee/nodeHost'
import { REFEREE_PROVIDERS } from '../referee/providers'
import { REFEREE_FIXTURE_SKIPS } from '../referee/fixtures'
import { CANNOT_CROSS, cannotCrossFor, socketAdapterFixture } from '../referee/socketFixture'
import type { HostCommand } from '../referee/wire'
import { describeAdapterContract } from './adapterContract'

// A case here starts a host process, and some start it twice; the in-process contract's 15 seconds are for an adapter alone.
// The waits inside fail with a sentence at half this.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const chosen = process.env.SOTTO_REFEREE_PROVIDERS?.split(',').filter(Boolean) ?? REFEREE_PROVIDERS
const providers = REFEREE_PROVIDERS.filter(provider => chosen.includes(provider))

// Linux, where the replays run, for the same reason: the hosts the Rust host replaces first are Linux machines.
describe.skipIf(process.platform !== 'linux')('the adapter contract across the socket', () => {
  let build: string
  let command: HostCommand
  beforeAll(async () => {
    build = await mkdtemp(join(tmpdir(), 'sotto-referee-build-'))
    command = namedRefereeHost() ?? await buildNodeRefereeHost(build)
  }, 120_000)
  afterAll(async () => { if (build && dirname(build) === tmpdir() && build.includes('sotto-referee-build-')) await rm(build, { recursive: true, force: true }) })

  for (const provider of providers) {
    // A fixture's own skips hold across the socket as they do in process.
    describeAdapterContract(`Socket host ${provider}`, () => socketAdapterFixture(command, provider), REFEREE_FIXTURE_SKIPS[provider],
      { ...CANNOT_CROSS, ...cannotCrossFor(provider) })
  }
})
