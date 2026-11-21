// @vitest-environment node
/**
 * A run a thread started on another machine, end to end over this computer's real process table (#2749): a stand-in
 * client, a script named `codex` that Node runs, is left running with the laptop thread's session in its environment, as a
 * skill's `ssh forge "CLAUDE_CODE_SESSION_ID=… bash start-builder.sh …"` leaves a builder on forge. The host's watch, which
 * owns no thread that session names, finds it with the real scan and reports it; the desktop's watch shows it as the laptop
 * thread's run, named for the host; and Stop on the desktop reaches the host, which looks again and ends the real process.
 * The socket between the two is covered by socketDetachedRunsElsewhere.test.ts. The scan here reads only the stand-in.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { scanProcesses, type ScanProcesses } from '../../src/main/agents/detachedRunScan'
import { DetachedRunWatch } from '../../src/main/agents/detachedRuns'

const FORGE = '62c79358-687d-4274-a876-1a0d79e1c195'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('finds a run left with another machine\'s thread\'s session, shows it as that thread\'s, and stops it from there', async () => {
  const session = randomUUID()
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'sotto-detached-elsewhere-')))
  const script = join(folder, 'codex.mjs')
  await writeFile(script, 'setInterval(() => {}, 1000)\n')
  const child: ChildProcess = spawn(process.execPath, [script, 'exec', '--json', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=max', 'Build the showroom'], {
    cwd: folder, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true, env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
  })
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await rm(folder, { recursive: true, force: true }) })
  const pid = child.pid!
  await new Promise(done => setTimeout(done, 500))
  // The real scan, kept to the stand-in, so nothing else on this computer is read.
  const onlyTheStandIn: ScanProcesses = include => scanProcesses((found, table) => found.pid === pid && include(found, table))

  // Forge: none of its threads owns the session; the stand-in is outside its process tree, as a run over ssh is.
  const forge = new DetachedRunWatch({ scan: onlyTheStandIn, rootPid: -1, owner: () => undefined })
  cleanup.push(() => forge.close())
  forge.subscribeForeign(() => undefined)
  expect(await forge.lookNow()).toBe(true)
  const reported = forge.foreignRuns()
  expect(reported).toHaveLength(1)
  expect(reported[0]).toMatchObject({ marks: [{ name: 'CLAUDE_CODE_SESSION_ID', value: session }], work: { type: 'detached-run', run: { client: 'Codex', model: 'gpt-6-astra', effort: 'max' } } })

  // The laptop: its own thread's session; Stop goes to the host that reported the run.
  const laptop = new DetachedRunWatch({ scan: async () => ({ processes: new Map(), agents: [] }), rootPid: process.pid,
    owner: mark => mark.value === session ? 'gt3rs-thread' : undefined,
    elsewhere: { look: () => forge.turnEnded(), stop: async (hostId, runId, mark) => { expect(hostId).toBe(FORGE); await forge.stopForeign(runId, mark) } } })
  cleanup.push(() => laptop.close())
  laptop.setElsewhere(FORGE, 'forge', reported)
  const shown = laptop.runsFor('gt3rs-thread')!
  expect(shown).toHaveLength(1)
  expect(shown[0]).toMatchObject({ label: 'Codex run', run: { client: 'Codex', machine: 'forge' } })

  await laptop.stop('gt3rs-thread', shown[0]!.id)
  const after = await scanProcesses(found => found.pid === pid)
  expect(after.agents.find(item => item.pid === pid), 'the stand-in has ended').toBeUndefined()
  expect(forge.foreignRuns()).toEqual([])
}, 120_000)
