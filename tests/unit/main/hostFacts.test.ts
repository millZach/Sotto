import { describe, expect, it } from 'vitest'
import { parseOsRelease, readHostFacts, type HostFactsSystem } from '../../../src/main/agents/hostFacts'

const NOW = new Date('2026-10-14T12:00:00.000Z')
const GIB = 1024 ** 3

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
