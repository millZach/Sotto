// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentBackgroundWorkSchema, detachedRunsElsewhereSchema, type DetachedRunElsewhere } from '../../../src/shared/agentMonitoring'
import { DETACHED_RUN_ENDED, DetachedRunWatch } from '../../../src/main/agents/detachedRuns'
import type { AgentProcess, ListedProcess, ProcessTable, RunMark, ScanProcesses } from '../../../src/main/agents/detachedRunScan'

/**
 * Detached runs across machines (#2749): a laptop thread starts an agent run on forge over ssh, passing its own session
 * along. Forge's watch finds the run, which no thread there owns, and reports it to its desktops; the laptop's watch shows
 * it as that thread's run, naming forge, and its Stop goes back to forge.
 */
const SOTTO = 100
const LAPTOP_SESSION = '0d15c982-fe12-44e4-8834-23b3be4bd2eb'
const FORGE = '62c79358-687d-4274-a876-1a0d79e1c195'
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

const listed = (pid: number, parentPid: number, startedAt = pid * 1000): ListedProcess => ({ pid, parentPid, startedAt })
function codex(pid: number, parentPid: number, marks: readonly RunMark[]): AgentProcess {
  const argv = ['codex', 'exec', '--json', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=max', 'Build the showroom']
  return { ...listed(pid, parentPid), client: 'Codex', argv, commandLine: argv.join(' '), folder: '/home/zach/algo-attack/dopamine-gt3rs', marks }
}
const mark = (value = LAPTOP_SESSION): RunMark => ({ name: 'CLAUDE_CODE_SESSION_ID', value })
function computer(agents: AgentProcess[]) {
  let current = agents
  const scan = vi.fn<ScanProcesses>(async include => {
    const processes = new Map([listed(1, 0, 0), listed(SOTTO, 1, 500), ...current].map(item => [item.pid, item] as const))
    const table: ProcessTable = { processes, agents: current.filter(item => include(item, processes)) }
    return table
  })
  return { scan, set(next: AgentProcess[]) { current = next } }
}

describe('a host reports the runs it finds that none of its threads owns', () => {
  it('reports a marked run no thread here owns, with its marks, once at the top, and none of its own threads\' runs', async () => {
    const forge = computer([codex(2445800, 1, [mark()]), codex(2445801, 2445800, [mark()]), codex(500, 1, [mark('forge-thread-session')])])
    const watch = new DetachedRunWatch({ scan: forge.scan, rootPid: SOTTO, owner: item => item.value === 'forge-thread-session' ? 'forge-thread' : undefined })
    cleanup.push(() => watch.close())
    const heard = vi.fn()
    watch.subscribeForeign(heard)
    await watch.lookNow()
    const runs = watch.foreignRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ marks: [mark()], work: { label: 'Codex run', type: 'detached-run', run: { client: 'Codex', model: 'gpt-6-astra', effort: 'max' } } })
    expect(detachedRunsElsewhereSchema.safeParse(runs).success).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    // Its own thread's run stays its own.
    expect(watch.runsFor('forge-thread')).toHaveLength(1)
    // Nothing changed, nothing told.
    await watch.lookNow()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('stops a run it reported only once a fresh look finds the same process, and says when it has ended', async () => {
    const forge = computer([codex(2445800, 1, [mark()])])
    const end = vi.fn(async () => { forge.set([]); return true })
    const watch = new DetachedRunWatch({ scan: forge.scan, rootPid: SOTTO, owner: () => undefined, end })
    cleanup.push(() => watch.close())
    watch.subscribeForeign(() => undefined)
    await watch.lookNow()
    const id = watch.foreignRuns()[0]!.work.id
    await watch.stopForeign(id)
    expect(end).toHaveBeenCalledWith(2445800)
    expect(watch.foreignRuns()).toEqual([])
    await expect(watch.stopForeign(id)).rejects.toThrow(DETACHED_RUN_ENDED)
  })
})

describe('a desktop shows a run a paired host found as its own thread\'s', () => {
  async function reported(): Promise<DetachedRunElsewhere[]> {
    const forge = computer([codex(2445800, 1, [mark()]), codex(2445900, 1, [mark('another-desktop-session')])])
    const watch = new DetachedRunWatch({ scan: forge.scan, rootPid: SOTTO, owner: () => undefined })
    watch.subscribeForeign(() => undefined)
    await watch.lookNow()
    watch.close()
    return [...watch.foreignRuns()]
  }
  function laptop(stop = vi.fn(async () => undefined)) {
    const look = vi.fn()
    const watch = new DetachedRunWatch({ scan: computer([]).scan, rootPid: SOTTO, owner: item => item.value === LAPTOP_SESSION ? 'gt3rs-thread' : undefined, elsewhere: { look, stop } })
    cleanup.push(() => watch.close())
    return { watch, look, stop }
  }

  it('claims only the runs its own threads\' marks name, naming the machine they run on', async () => {
    const { watch } = laptop()
    const changed = vi.fn()
    watch.subscribe(changed)
    watch.setElsewhere(FORGE, 'forge', await reported())
    const runs = watch.runsFor('gt3rs-thread')!
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ label: 'Codex run', type: 'detached-run', run: { client: 'Codex', machine: 'forge', model: 'gpt-6-astra' } })
    expect(agentBackgroundWorkSchema.safeParse(runs).success).toBe(true)
    expect(changed).toHaveBeenCalledWith(['gt3rs-thread'])
    // The host going away takes its runs with it; they still run there.
    watch.setElsewhere(FORGE, 'forge', [])
    expect(watch.runsFor('gt3rs-thread')).toBeUndefined()
  })

  it('sends Stop to the host that found the run, by the host\'s own ID for it, and refuses it for another thread', async () => {
    const { watch, stop } = laptop()
    const runs = await reported()
    watch.setElsewhere(FORGE, 'forge', runs)
    const id = watch.runsFor('gt3rs-thread')![0]!.id
    // This desktop's ID for the run is its own, so a run of another machine with the same process numbers never shares it.
    expect(id).not.toBe(runs[0]!.work.id)
    await expect(watch.stop('some-other-thread', id)).rejects.toThrow(DETACHED_RUN_ENDED)
    expect(stop).not.toHaveBeenCalled()
    await watch.stop('gt3rs-thread', id)
    expect(stop).toHaveBeenCalledWith(FORGE, runs[0]!.work.id)
  })

  it('asks the adapters about a mark once, not at every report, and lists a thread\'s oldest runs whichever machine runs them', async () => {
    const owner = vi.fn((item: RunMark) => item.value === LAPTOP_SESSION ? 'gt3rs-thread' : undefined)
    const watch = new DetachedRunWatch({ scan: computer([]).scan, rootPid: SOTTO, owner })
    cleanup.push(() => watch.close())
    const runs = await reported()
    watch.setElsewhere(FORGE, 'forge', runs)
    const asked = owner.mock.calls.filter(([item]) => item.value === LAPTOP_SESSION).length
    watch.setElsewhere(FORGE, 'forge', [...runs])
    watch.setElsewhere('33333333-3333-4333-8333-333333333333', 'mac', runs)
    expect(owner.mock.calls.filter(([item]) => item.value === LAPTOP_SESSION).length).toBe(asked)
    // Seventeen runs on forge, newest first in the report: the sixteen oldest are listed.
    const many = Array.from({ length: 17 }, (_, index) => ({ ...runs[0]!, work: { ...runs[0]!.work, id: `${index.toString(16).padStart(8, '0')}-0000-5000-8000-000000000000`,
      startedAt: new Date(Date.UTC(2026, 10, 20, 20, 59 - index)).toISOString() } }))
    watch.setElsewhere('33333333-3333-4333-8333-333333333333', 'mac', [])
    watch.setElsewhere(FORGE, 'forge', many)
    const listed = watch.runsFor('gt3rs-thread')!
    expect(listed).toHaveLength(16)
    expect(listed.map(work => work.startedAt)).toEqual([...many].reverse().slice(0, 16).map(run => run.work.startedAt))
  })

  it('asks its paired hosts to look again when one of its own turns ends', () => {
    const { watch, look } = laptop()
    watch.turnEnded()
    expect(look).toHaveBeenCalledTimes(1)
  })
})
