import { describe, expect, it, vi } from 'vitest'
import { HostFactsSource, hostMachineReport, parseMemAvailable, parseMemoryPressure, parseOsRelease, readHostFacts, type HostFactsSystem } from '../../../src/main/agents/hostFacts'
import type { AgentState } from '../../../src/shared/agents'
import { HOST_FACTS_REFRESH_MS, HOST_LOAD_SAMPLE_MS, HOST_LOAD_WINDOW_MAX_MS } from '../../../src/shared/hostFacts'

const NOW = new Date('2026-10-14T12:00:00.000Z')
const GIB = 1024 ** 3

type ShellThread = { id: string; status: string }
type ShellSends = { deliveries?: { threadId: string; status: string }[]; followups?: { threadId: string; status: string }[] }
/** The parts of a shell the machine report reads. */
const shell = (threads: ShellThread[], sends: ShellSends = {}) => ({ host: { threads }, ...sends }) as unknown as Pick<AgentState, 'host' | 'deliveries' | 'followups'>

function system(overrides: Partial<HostFactsSystem> = {}): HostFactsSystem {
  return {
    platform: () => 'win32',
    release: () => '10.0.26200',
    version: () => 'Windows 10 Home',
    machine: () => 'x86_64',
    totalmem: () => 32 * GIB,
    freemem: () => 11 * GIB,
    cpus: () => Array.from({ length: 16 }, () => ({})),
    ...overrides,
  }
}

function files(contents: Readonly<Record<string, string>>): { readFile: (path: string) => Promise<string>; reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readFile: async path => {
      reads.push(path)
      const content = contents[path]
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return content
    },
  }
}

const read = (os: HostFactsSystem, contents: Readonly<Record<string, string>> = {}) =>
  readHostFacts({ os, readFile: files(contents).readFile, now: () => NOW })

describe('readHostFacts', () => {
  it('reads Windows 11 from its build, whatever the product name says', async () => {
    await expect(read(system())).resolves.toEqual({
      observedAt: '2026-10-14T12:00:00.000Z',
      os: { family: 'windows', name: 'Windows 11', version: '10.0.26200' },
      architecture: 'x64',
      totalMemoryBytes: 32 * GIB,
      freeMemoryBytes: 11 * GIB,
      logicalCpuCount: 16,
    })
  })

  it('reads Windows 11 from its first build and Windows 10 below it', async () => {
    expect((await read(system({ release: () => '10.0.22000' }))).os.name).toBe('Windows 11')
    expect((await read(system({ release: () => '10.0.19045' }))).os).toEqual({ family: 'windows', name: 'Windows 10', version: '10.0.19045' })
  })

  it('names a Windows server by its product name rather than its build', async () => {
    const facts = await read(system({ release: () => '10.0.20348', version: () => 'Windows Server 2022 Datacenter' }))
    expect(facts.os).toEqual({ family: 'windows', name: 'Windows Server 2022 Datacenter', version: '10.0.20348' })
  })

  it('leaves an older or unreadable Windows release unnamed', async () => {
    expect((await read(system({ release: () => '6.3.9600' }))).os).toEqual({ family: 'windows', name: null, version: '6.3.9600' })
    expect((await read(system({ release: () => { throw new Error('no') } }))).os).toEqual({ family: 'windows', name: null, version: null })
  })

  it('reads macOS and its marketing version from the system version file', async () => {
    const plist = '<plist><dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>15.3.1</string>\n</dict></plist>'
    const { readFile, reads } = files({ '/System/Library/CoreServices/SystemVersion.plist': plist })
    const facts = await readHostFacts({ os: system({ platform: () => 'darwin', release: () => '24.3.0', machine: () => 'arm64' }), readFile, now: () => NOW })
    expect(facts.os).toEqual({ family: 'macos', name: 'macOS', version: '15.3.1' })
    expect(facts.architecture).toBe('arm64')
    expect(reads).toEqual(['/System/Library/CoreServices/SystemVersion.plist'])
  })

  it('leaves the macOS version unknown when the system version file cannot be read', async () => {
    const facts = await read(system({ platform: () => 'darwin', release: () => '24.3.0' }))
    expect(facts.os).toEqual({ family: 'macos', name: 'macOS', version: null })
  })

  it('reads Linux exactly as its os-release names it', async () => {
    // forge's /etc/os-release, October 14, 2026.
    const omarchy = 'NAME="Omarchy"\nPRETTY_NAME="Omarchy"\nID=omarchy\nID_LIKE=arch\nBUILD_ID="4.0.4"\nVERSION_ID="4.0.4"\nANSI_COLOR="38;2;158;206;106"\nLOGO=omarchy\n'
    const facts = await read(system({ platform: () => 'linux', release: () => '6.17.1-arch1-1', machine: () => 'x86_64' }), { '/etc/os-release': omarchy })
    expect(facts.os).toEqual({ family: 'linux', name: 'Omarchy', version: '4.0.4' })
    expect(facts.architecture).toBe('x64')
  })

  it('leaves the version unknown when os-release gives no VERSION_ID, as Arch does', async () => {
    const facts = await read(system({ platform: () => 'linux' }), { '/etc/os-release': 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n' })
    expect(facts.os).toEqual({ family: 'linux', name: 'Arch Linux', version: null })
  })

  it('falls back from PRETTY_NAME to NAME and reads VERSION_ID', async () => {
    const facts = await read(system({ platform: () => 'linux' }), { '/etc/os-release': "NAME='Ubuntu'\nVERSION_ID=\"24.04\"\n" })
    expect(facts.os).toEqual({ family: 'linux', name: 'Ubuntu', version: '24.04' })
  })

  it('reads the vendor os-release when the administrator has none', async () => {
    const { readFile, reads } = files({ '/usr/lib/os-release': 'PRETTY_NAME="Arch Linux"\n' })
    const facts = await readHostFacts({ os: system({ platform: () => 'linux' }), readFile, now: () => NOW })
    expect(facts.os).toEqual({ family: 'linux', name: 'Arch Linux', version: null })
    expect(reads).toEqual(['/etc/os-release', '/usr/lib/os-release'])
  })

  it('leaves the Linux name unknown when there is no os-release at all', async () => {
    const facts = await read(system({ platform: () => 'linux' }))
    expect(facts.os).toEqual({ family: 'linux', name: null, version: null })
    expect(facts.totalMemoryBytes).toBe(32 * GIB)
  })

  it('reads an unknown operating system as unknown, not as Windows', async () => {
    const facts = await read(system({ platform: () => 'freebsd' }))
    expect(facts.os).toEqual({ family: null, name: null, version: null })
  })

  it('keeps every other fact when one cannot be read', async () => {
    const facts = await read(system({
      machine: () => { throw new Error('no') },
      totalmem: () => Number.NaN,
      freemem: () => -1,
      cpus: () => [],
    }))
    expect(facts).toEqual({
      observedAt: '2026-10-14T12:00:00.000Z',
      os: { family: 'windows', name: 'Windows 11', version: '10.0.26200' },
      architecture: null, totalMemoryBytes: null, freeMemoryBytes: null, logicalCpuCount: null,
    })
  })

  it('reports an architecture it does not map as the system names it', async () => {
    expect((await read(system({ machine: () => 'riscv64' }))).architecture).toBe('riscv64')
  })

  it('refuses no fact for being too long; it reads unknown instead', async () => {
    const facts = await read(system({ platform: () => 'linux' }), { '/etc/os-release': `PRETTY_NAME="${'x'.repeat(201)}"\nNAME=Short\n` })
    expect(facts.os.name).toBe('Short')
  })
})

describe('parseOsRelease', () => {
  it('reads unquoted, single-quoted and escaped double-quoted values and skips comments', () => {
    const fields = parseOsRelease('# comment\nNAME=Arch\r\nPRETTY_NAME="Say \\"hi\\" \\\\ there"\nVERSION=\'1 (one)\'\nnot a field\n')
    expect(Object.fromEntries(fields)).toEqual({ NAME: 'Arch', PRETTY_NAME: 'Say "hi" \\ there', VERSION: '1 (one)' })
  })
})

describe('HostFactsSource', () => {
  /** A machine whose memory and clock the test moves, counting what the source reads. */
  function machine() {
    let free = 11 * GIB, at = NOW.getTime(), platformReads = 0, memoryReads = 0, fileReads = 0
    const os = system({ platform: () => { platformReads += 1; return 'linux' }, freemem: () => { memoryReads += 1; return free } })
    const source = new HostFactsSource({ os, now: () => new Date(at), sleep: async () => undefined,
      readFile: async () => { fileReads += 1; return 'PRETTY_NAME="Omarchy"\nVERSION_ID="4.0.4"\n' } })
    return { source, setFree: (bytes: number) => { free = bytes }, advance: (ms: number) => { at += ms },
      counts: () => ({ platformReads, memoryReads, fileReads }) }
  }

  it('reads the operating system once and memory again only once its reading is old, never on a timer', async () => {
    const m = machine()
    const first = await m.source.read()
    expect(first).toMatchObject({ observedAt: NOW.toISOString(), os: { family: 'linux', name: 'Omarchy', version: '4.0.4' }, freeMemoryBytes: 11 * GIB })
    m.setFree(3 * GIB); m.advance(HOST_FACTS_REFRESH_MS - 1)
    // Asked again inside the refresh window: the same reading, with nothing read again.
    expect(await m.source.read()).toBe(first)
    expect(m.counts()).toEqual({ platformReads: 1, memoryReads: 1, fileReads: 1 })
    m.advance(1)
    const refreshed = await m.source.read()
    expect(refreshed).toEqual({ ...first, observedAt: new Date(NOW.getTime() + HOST_FACTS_REFRESH_MS).toISOString(), freeMemoryBytes: 3 * GIB })
    // Memory was read again; the operating system was not.
    expect(m.counts()).toEqual({ platformReads: 1, memoryReads: 2, fileReads: 1 })
  })

  it('reads memory afresh when first asked long after the start-up reading', async () => {
    const m = machine()
    await m.source.read()
    m.setFree(2 * GIB); m.advance(60 * 60_000)
    expect(await m.source.read()).toMatchObject({ freeMemoryBytes: 2 * GIB, observedAt: new Date(NOW.getTime() + 60 * 60_000).toISOString() })
  })

  it('answers several asks at once with one reading', async () => {
    const m = machine()
    const [a, b, c] = await Promise.all([m.source.read(), m.source.read(), m.source.read()])
    expect(a).toEqual(b); expect(b).toEqual(c)
    expect(m.counts()).toEqual({ platformReads: 1, memoryReads: 1, fileReads: 1 })
  })

  it('counts only the threads running a turn as the machine’s running threads', async () => {
    const m = machine()
    const report = await hostMachineReport(m.source, shell([{ id: 'a', status: 'running' }, { id: 'b', status: 'idle' }, { id: 'c', status: 'running' }, { id: 'd', status: 'error' }]))
    expect(report).toMatchObject({ runningThreads: 2, facts: { os: { name: 'Omarchy' } } })
    expect((await hostMachineReport(m.source, shell([]))).runningThreads).toBe(0)
  })
})

describe('live load', () => {
  /** A machine whose CPU counters, memory and clock the test moves. Each CPU's counters are given as busy and idle time. */
  function loaded(platform: 'win32' | 'linux' | 'darwin', files: Readonly<Record<string, string>> = {}, { meminfo: meminfoText }: { meminfo?: string | null } = {}) {
    let at = NOW.getTime(), busy = 0, idle = 0, free = 11 * GIB, available = 9 * GIB, cpuReads = 0
    const sleeps: number[] = []
    const os = system({
      platform: () => platform,
      freemem: () => free,
      cpus: () => { cpuReads += 1; return Array.from({ length: 4 }, () => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } })) },
      loadavg: () => [1.234, 0.5, 0.25],
    })
    const meminfo = () => `MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   ${available / 1024} kB\n`
    const source = new HostFactsSource({ os, now: () => new Date(at),
      readFile: async path => {
        if (path === '/proc/meminfo') {
          if (meminfoText === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          return meminfoText ?? meminfo()
        }
        if (path === '/etc/os-release') return 'PRETTY_NAME="Omarchy"\n'
        const content = files[path]
        if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return content
      },
      // Waiting moves the clock.
      sleep: async ms => { sleeps.push(ms); at += ms },
    })
    return { source, sleeps, cpuReads: () => cpuReads,
      advance: (ms: number) => { at += ms },
      work: (busyMs: number, idleMs: number) => { busy += busyMs; idle += idleMs },
      setFree: (bytes: number) => { free = bytes }, setAvailable: (bytes: number) => { available = bytes } }
  }

  it('takes two samples a few seconds apart when it has none, and reads counters that did not move as unknown, not idle', async () => {
    const m = loaded('win32')
    const load = await m.source.load()
    expect(m.sleeps).toEqual([HOST_LOAD_SAMPLE_MS])
    expect(load).toEqual({ observedAt: new Date(NOW.getTime() + HOST_LOAD_SAMPLE_MS).toISOString(), windowMs: HOST_LOAD_SAMPLE_MS,
      cpuBusyPercent: null, loadAverage: null, availableMemoryBytes: 11 * GIB, windowStartAvailableMemoryBytes: 11 * GIB, memoryPressurePercent: null })
  })

  it('reads over the window since the last sample, without waiting, once that sample is a few seconds old', async () => {
    const m = loaded('win32')
    await m.source.primeLoad()
    m.work(900, 100); m.setFree(3 * GIB); m.advance(10_000)
    const load = await m.source.load()
    expect(m.sleeps).toEqual([])
    expect(load).toMatchObject({ windowMs: 10_000, cpuBusyPercent: 90, availableMemoryBytes: 3 * GIB, windowStartAvailableMemoryBytes: 11 * GIB })
    // Asked again inside the refresh window: the same reading, with nothing read again.
    const reads = m.cpuReads()
    m.advance(HOST_FACTS_REFRESH_MS - 1)
    expect(await m.source.load()).toBe(load)
    expect(m.cpuReads()).toBe(reads)
    // Once it is old, the next window starts where the last one ended.
    m.work(100, 900); m.advance(1)
    expect(await m.source.load()).toMatchObject({ windowMs: HOST_FACTS_REFRESH_MS, cpuBusyPercent: 10, windowStartAvailableMemoryBytes: 3 * GIB })
  })

  it('waits out the rest of the sample gap when the last sample is too new, and samples twice afresh when it is over a minute old', async () => {
    const m = loaded('win32')
    await m.source.primeLoad()
    m.advance(500)
    await m.source.load()
    expect(m.sleeps).toEqual([HOST_LOAD_SAMPLE_MS - 500])
    m.advance(HOST_LOAD_WINDOW_MAX_MS + 1)
    expect(await m.source.load()).toMatchObject({ windowMs: HOST_LOAD_SAMPLE_MS })
    expect(m.sleeps).toEqual([HOST_LOAD_SAMPLE_MS - 500, HOST_LOAD_SAMPLE_MS])
  })

  it('answers several asks at once with one reading', async () => {
    const m = loaded('win32')
    const [a, b] = await Promise.all([m.source.load(), m.source.load()])
    expect(a).toBe(b)
    expect(m.sleeps).toHaveLength(1)
  })

  it('reads Linux available memory, load average and memory pressure', async () => {
    const m = loaded('linux', { '/proc/pressure/memory': 'some avg10=3.25 avg60=1.00 avg300=0.50 total=12345\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' })
    await m.source.primeLoad()
    m.setAvailable(5 * GIB); m.work(400, 400); m.advance(4_000)
    expect(await m.source.load()).toMatchObject({ cpuBusyPercent: 50, loadAverage: 1.23, availableMemoryBytes: 5 * GIB,
      windowStartAvailableMemoryBytes: 9 * GIB, memoryPressurePercent: 3.25 })
  })

  it('reads Linux without pressure where the kernel gives none', async () => {
    const m = loaded('linux')
    expect(await m.source.load()).toMatchObject({ memoryPressurePercent: null, availableMemoryBytes: 9 * GIB })
  })

  it('reads Linux available memory as unknown, not as free memory, when MemAvailable cannot be read', async () => {
    const unreadable = loaded('linux', {}, { meminfo: null })
    expect(await unreadable.source.load()).toMatchObject({ availableMemoryBytes: null, windowStartAvailableMemoryBytes: null })
    const without = loaded('linux', {}, { meminfo: 'MemTotal:       32000000 kB\nMemFree:         1000000 kB\n' })
    expect(await without.source.load()).toMatchObject({ availableMemoryBytes: null, windowStartAvailableMemoryBytes: null })
  })

  it('reads macOS memory as unknown, since its free memory understates, and keeps its load average', async () => {
    const m = loaded('darwin')
    expect(await m.source.load()).toMatchObject({ availableMemoryBytes: null, windowStartAvailableMemoryBytes: null, loadAverage: 1.23, memoryPressurePercent: null })
  })

  it('reads CPU busy as unknown when a CPU gives no counters', async () => {
    const source = new HostFactsSource({ os: system({ cpus: () => [{ times: { user: 1, idle: 1 } }, {}] }), now: () => NOW, sleep: async () => undefined })
    expect((await source.load()).cpuBusyPercent).toBeNull()
  })

  it('parses MemAvailable and memory pressure, and reads anything else as unknown', () => {
    expect(parseMemAvailable('MemTotal: 10 kB\nMemAvailable:    2048 kB\n')).toBe(2 * 1024 * 1024)
    expect(parseMemAvailable('MemTotal: 10 kB\n')).toBeNull()
    expect(parseMemoryPressure('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')).toBe(0)
    expect(parseMemoryPressure('full avg10=1.00\n')).toBeNull()
    expect(parseMemoryPressure('some avg10=101.00\n')).toBeNull()
  })
})

describe('the machine report', () => {
  const quiet = () => new HostFactsSource({ os: system(), now: () => NOW, sleep: async () => undefined })

  it('counts work placed but not started: threads not running whose send has not begun, once each', async () => {
    const report = await hostMachineReport(quiet(), shell(
      [{ id: 'new', status: 'idle' }, { id: 'busy', status: 'running' }, { id: 'next', status: 'idle' }, { id: 'done', status: 'idle' }, { id: 'failed', status: 'error' }],
      { deliveries: [{ threadId: 'new', status: 'queued' }, { threadId: 'new', status: 'submitting' }, { threadId: 'busy', status: 'submitting' },
        { threadId: 'done', status: 'accepted' }, { threadId: 'failed', status: 'failed' }],
        followups: [{ threadId: 'next', status: 'dispatching' }, { threadId: 'busy', status: 'queued' }] }))
    expect(report).toMatchObject({ runningThreads: 1, placedNotStarted: 2 })
    expect(report.load).toMatchObject({ availableMemoryBytes: 11 * GIB })
  })

  it('keeps the facts when the load cannot be read', async () => {
    const source = quiet()
    vi.spyOn(source, 'load').mockRejectedValue(new Error('unreadable'))
    expect(await hostMachineReport(source, shell([]))).toMatchObject({ load: null, placedNotStarted: 0, facts: { os: { name: 'Windows 11' } } })
  })
})
