// @vitest-environment node
// The referee harness (docs/plans/2026-11-14-rust-native-port.md, "Rules for the whole port"): every provider's script played
// against a host started by its command line, and compared with the TypeScript host's recording. The host is the Node
// referee host unless SOTTO_REFEREE_HOST names another; docs/verification/2026-11-19-referee-harness.md says how.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildNodeRefereeHost, namedRefereeHost } from '../referee/nodeHost'
import { REFEREE_PROVIDERS, type RefereeProvider } from '../referee/providers'
import { formatRecording, runScenario, type Recording } from '../referee/runner'
import { heldOut, recordingName, SCENARIOS, script, type ScenarioName } from '../referee/scenario'
import type { HostCommand } from '../referee/wire'

// SOTTO_REFEREE_RECORDINGS writes and reads recordings somewhere else, to compare two recording runs.
const RECORDINGS = resolve(process.env.SOTTO_REFEREE_RECORDINGS ?? 'tests/referee/recordings')
const recordingPath = (provider: RefereeProvider, scenario: ScenarioName): string => join(RECORDINGS, `${recordingName(provider, scenario)}.json`)

const recording = process.env.SOTTO_REFEREE_RECORD === '1'
const repeats = Math.max(1, Number(process.env.SOTTO_REFEREE_REPEAT ?? '1') || 1)
const chosen = process.env.SOTTO_REFEREE_PROVIDERS?.split(',').filter(Boolean) ?? REFEREE_PROVIDERS
// SOTTO_REFEREE_SCENARIOS plays only the scripts it names.
const scenarios = process.env.SOTTO_REFEREE_SCENARIOS?.split(',').filter(Boolean)
const providers = REFEREE_PROVIDERS.filter(provider => chosen.includes(provider))

// The recordings are made on Linux, where the remote hosts the Rust host replaces first run (stage 2); paths and the
// machine's own facts would differ on Windows and macOS. CI replays them in "Host archive and socket contract (Linux)".
describe.skipIf(process.platform !== 'linux')('the referee harness', () => {
  let build: string
  let command: HostCommand
  beforeAll(async () => {
    build = await mkdtemp(join(tmpdir(), 'sotto-referee-build-'))
    const named = namedRefereeHost()
    // The TypeScript host is the referee: only it records, so a host under test can never replace what it is held to.
    if (named && recording) throw new Error('SOTTO_REFEREE_RECORD records the TypeScript host only; leave SOTTO_REFEREE_HOST unset to record.')
    command = named ?? await buildNodeRefereeHost(build)
  }, 120_000)
  afterAll(async () => { if (build && dirname(build) === tmpdir() && build.includes('sotto-referee-build-')) await rm(build, { recursive: true, force: true }) })

  for (const provider of providers) for (const scenario of SCENARIOS.filter(name => script(provider, name) && (!scenarios || scenarios.includes(name)))) {
    const named = scenario === 'main' ? provider : `${provider} (${scenario})`
    // SOTTO_REFEREE_HELD_OUT=1 plays a held-out script too, to see whether its issue is fixed.
    const held = process.env.SOTTO_REFEREE_HELD_OUT === '1' ? undefined : heldOut(provider, scenario)
    it(`${recording ? 'records' : 'replays'} ${named} at the socket${repeats > 1 ? `, ${repeats} times` : ''}`, async context => {
      if (held) { context.skip(held); return }
      if (recording) {
        const { recording: made, failures } = await runScenario({ command, provider, scenario })
        expect(failures).toEqual([])
        await writeFile(recordingPath(provider, scenario), formatRecording(made))
        return
      }
      const against = JSON.parse(await readFile(recordingPath(provider, scenario), 'utf8')) as Recording
      for (let run = 1; run <= repeats; run++) {
        const { failures } = await runScenario({ command, provider, scenario, against })
        expect(failures, `Run ${run} of ${repeats} against ${named}'s recording`).toEqual([])
      }
    }, 180_000 * repeats)
  }
})
