import { parseProviderRecords } from './providerRecords'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** What the fake `systemctl --user` and `loginctl` start from; see tests/fixtures/fakeSystemdCommand.mjs. */
export interface FakeSystemdState {
  /** False for a machine that does not run systemd at all. */
  systemd?: boolean
  userManager?: boolean
  linger?: boolean
  enableLinger?: 'allow' | 'refuse'
  enabled?: boolean
  startExit?: number
  enableExit?: number
  afterStart?: 'run' | 'failed' | 'crash-loop' | 'retry-once' | 'lost-lock'
  /** `afterStart` holds for the next start alone; the unit runs the host from the one after. */
  once?: boolean
  mainPid?: number
  unit?: { ActiveState: string; SubState: string; Result: string; NRestarts: string; ExecMainStatus: string }
  /** The host's data folder, where `lost-lock` waits for the other host's lock. */
  data?: string
}
export interface FakeSystemdCall { readonly command: string; readonly args: string[] }
export interface FakeSystemd {
  /** The environment a launch script runs under to meet the fakes first on its path, with its own systemd folder. */
  readonly env: NodeJS.ProcessEnv
  /** Where the launch script writes the unit. */
  readonly unitPath: string
  state(): Promise<FakeSystemdState & { enabled: boolean }>
  set(patch: Partial<FakeSystemdState>): Promise<void>
  /** Every systemctl and loginctl call, in order, as `systemctl --user start sotto-host`-style lines without `--user`. */
  calls(): Promise<string[]>
  /** Every host process the fake started, for the test to stop. */
  spawned(): Promise<number[]>
}

/**
 * Puts fake `systemctl` and `loginctl` executables first on the path, over a state file, under `directory`. On Windows,
 * where only Sotto's tests run the launch script, they are command scripts the launch script reaches through cmd.exe.
 */
export async function fakeSystemd(directory: string, initial: FakeSystemdState = {}, base: NodeJS.ProcessEnv = process.env): Promise<FakeSystemd> {
  const bin = join(directory, 'fake-systemd-bin'), config = join(directory, 'fake-config'), statePath = join(directory, 'fake-systemd.json'), recordPath = join(directory, 'fake-systemd.jsonl')
  await mkdir(bin, { recursive: true }); await mkdir(config, { recursive: true })
  await writeFile(statePath, JSON.stringify(initial)); await writeFile(recordPath, '')
  const script = resolve('tests/fixtures/fakeSystemdCommand.mjs')
  for (const name of ['systemctl', 'loginctl']) {
    if (process.platform === 'win32') await writeFile(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" ${name} %*\r\n@exit /b %errorlevel%\r\n`)
    else { await writeFile(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${script}' ${name} "$@"\n`); await chmod(join(bin, name), 0o755) }
  }
  // Windows keeps the path under whatever case it was given; replacing that key, not adding another, is what a child sees.
  const pathKey = Object.keys(base).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const env: NodeJS.ProcessEnv = { ...base, [pathKey]: [bin, base[pathKey]].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
    XDG_CONFIG_HOME: config, FAKE_SYSTEMD_STATE: statePath, FAKE_SYSTEMD_RECORD: recordPath }
  const records = async (): Promise<Record<string, unknown>[]> => parseProviderRecords<Record<string, unknown>>(await readFile(recordPath, 'utf8'), { trim: false })
  return {
    env, unitPath: join(config, 'systemd', 'user', 'sotto-host.service'),
    state: async () => ({ enabled: false, ...JSON.parse(await readFile(statePath, 'utf8')) as FakeSystemdState }),
    set: async patch => { await writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')) as FakeSystemdState, ...patch })) },
    calls: async () => (await records()).flatMap(item => typeof item.command === 'string'
      ? [[item.command, ...(item.args as string[]).filter(word => word !== '--user' && word !== '--no-ask-password')].join(' ')] : []),
    spawned: async () => (await records()).flatMap(item => typeof item.spawned === 'number' ? [item.spawned] : typeof item.otherHost === 'number' ? [item.otherHost] : []),
  }
}
