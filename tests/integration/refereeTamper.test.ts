// @vitest-environment node
// The referee harness must fail a host that differs from the recording, and say how in words a person can act on. Each
// case here is a host changed on purpose: what one client is sent is altered before the referee reads it, so the referee
// sees a host that sent exactly that.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildNodeRefereeHost } from '../referee/nodeHost'
import { NORMALISATION_RULES } from '../referee/normalise'
import { runScenario, type Recording, type Tamper } from '../referee/runner'
import { HELD_OUT, THREAD } from '../referee/scenario'
import { REFEREE_PROVIDERS } from '../referee/providers'
import { CANNOT_CROSS, cannotCrossFor } from '../referee/socketFixture'
import type { HostCommand } from '../referee/wire'

// Each rule is a place a wrong host could hide, so the note a reader of the recordings reads names every one.
it('names every normalisation rule in the verification note', async () => {
  const note = await readFile(resolve('docs/verification/2026-11-19-referee-harness.md'), 'utf8')
  expect(NORMALISATION_RULES.map(rule => rule.name).filter(name => !note.includes(`| ${name} |`))).toEqual([])
})

// So is each contract case that does not cross the socket, and each script held out of the replays.
it('names every contract case that cannot cross the socket, and every held-out script, in the verification note', async () => {
  const note = (await readFile(resolve('docs/verification/2026-11-19-referee-harness.md'), 'utf8')).replace(/\s+/gu, ' ')
  const named = [...Object.keys(CANNOT_CROSS), ...REFEREE_PROVIDERS.flatMap(provider => Object.keys(cannotCrossFor(provider)))]
  expect([...new Set(named)].filter(name => !note.includes(name))).toEqual([])
  expect(Object.keys(HELD_OUT).filter(scenario => !note.includes(`\`${scenario}\``))).toEqual([])
})

/** A wrong host fails at its first wrong step once this passes; a right one never waits on it. */
const STEP_DEADLINE_MS = 5_000

describe.skipIf(process.platform !== 'linux')('the referee harness fails a changed host', () => {
  let build: string
  let command: HostCommand
  let recording: Recording
  beforeAll(async () => {
    build = await mkdtemp(join(tmpdir(), 'sotto-referee-build-'))
    command = await buildNodeRefereeHost(build)
    recording = JSON.parse(await readFile(resolve('tests/referee/recordings/codex.json'), 'utf8')) as Recording
  }, 120_000)
  afterAll(async () => { if (build && dirname(build) === tmpdir() && build.includes('sotto-referee-build-')) await rm(build, { recursive: true, force: true }) })
  const replay = async (tamper: Partial<Record<'desktop' | 'iphone' | 'plain', Tamper>>): Promise<string> =>
    (await runScenario({ command, provider: 'codex', against: recording, tamper, stepDeadlineMs: STEP_DEADLINE_MS })).failures.join('\n')

  it('names the field a host left out, the step and the client', async () => {
    // Every thread record the desktop is pushed loses its title.
    const failures = await replay({ desktop: (frame, emit) => {
      const changed = (frame.threads as { changed?: Record<string, unknown>[] } | undefined)?.changed
      if (frame.event === 'shell' && changed) for (const record of changed) delete record.title
      emit(frame)
    } })
    expect(failures).toContain('Step 7 (desktop makes the thread), desktop, what the client holds once the step is over:')
    expect(failures).toContain('at shell.host.threads[0].title: recorded "Referee thread", this host sent no such field')
  }, 120_000)

  it('names two frames a host sent in the other order', async () => {
    // The iPhone is answered `observe` before the thread it names is pushed, where the protocol promises the push first.
    let held: Record<string, unknown> | undefined, swapped = false
    const failures = await replay({ iphone: (frame, emit) => {
      if (frame.event === 'detail' && !swapped && !held) { held = frame; return }
      emit(frame)
      if (held && !swapped && frame.id !== undefined) { emit(held); swapped = true }
    } })
    expect(failures).toContain(`Step 9 (iphone observes the thread), iphone: The host answered observe before it pushed thread ${THREAD}.`)
  }, 120_000)

  it('names a delta a host sent twice', async () => {
    let doubled = false
    const failures = await replay({ desktop: (frame, emit) => {
      emit(frame)
      if (frame.event === 'detail-delta' && !doubled) { doubled = true; emit(structuredClone(frame)) }
    } })
    expect(failures).toMatch(/Step \d+ \([^)]+\), desktop: A detail delta to revision \d+ arrived for thread [0-9a-f-]+, whose revision \d+ the client already holds\./u)
  }, 120_000)
})
