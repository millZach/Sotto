import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OwnServer } from '../../shared/ownModelServers'
import { hermesEnvironment, withHermesPath } from './hermesRpc'

/**
 * The keys of the user's own keyed servers, as Sotto's Hermes keeps them (ADR-0124): one file under Sotto's Hermes
 * folder, readable by the user alone. A key arrives from the Add dialog once, beside OpenCode's copy, and leaves on Remove.
 */
export class HermesKeys {
  constructor(private readonly path: string) {}
  async read(): Promise<Record<string, string>> {
    const text = await readFile(this.path, 'utf8').catch(() => '{}')
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  }
  async keep(id: string, key: string): Promise<void> { await this.write({ ...await this.read(), [id]: key }) }
  async forget(id: string): Promise<void> {
    const keys = await this.read()
    if (!(id in keys)) return
    delete keys[id]
    await this.write(keys)
  }
  private async write(keys: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const next = `${this.path}.next`
    await writeFile(next, JSON.stringify(keys), { mode: 0o600 })
    await rename(next, this.path)
  }
}

/** The variable a keyed server's key reaches Hermes by, from its profile's `.env`; the config names only the variable. */
export function hermesKeyVariable(id: string): string {
  return `SOTTO_${id.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}_KEY`
}

/** The servers Hermes can run: every keyless one, and each keyed one whose key Sotto's Hermes holds. */
export function hermesServers(servers: readonly OwnServer[], keys: Readonly<Record<string, string>>): OwnServer[] {
  return servers.filter(server => !server.keyed || keys[server.id] !== undefined)
}

/** A profile's `.env`: one line per keyed server, quoted so no character in a key can end its line early. */
export function hermesEnvFile(servers: readonly OwnServer[], keys: Readonly<Record<string, string>>): string {
  return servers.filter(server => server.keyed && keys[server.id] !== undefined)
    .map(server => `${hermesKeyVariable(server.id)}=${JSON.stringify(keys[server.id])}\n`).join('')
}

export function hermesProjectHome(root: string, projectPath: string): string {
  return join(root, 'profiles', `project-${createHash('sha256').update(projectPath).digest('hex').slice(0, 24)}`)
}

/** JSON is YAML: no interpolation of model names, addresses, paths or secrets. */
export function hermesConfig(servers: readonly OwnServer[], cwd?: string): string {
  const first = servers[0]
  return JSON.stringify({
    _config_version: 52,
    auth: { adopt_external_logins: false }, approvals: { mode: 'off' },
    gateway: { multiplex_profiles: true }, updates: { check: false }, plugins: { auto_update_check_hours: 0, auto_apply: false },
    fallback_model: [], agent: { reasoning_effort: 'high' },
    auxiliary: { title_generation: { enabled: false, model_upgrade_enabled: false },
      compression: { provider: 'auto', model: '' }, vision: { provider: 'auto', model: '' } },
    memory: { memory_enabled: true, user_profile_enabled: true },
    ...(cwd ? { terminal: { cwd } } : {}),
    ...(first ? { model: { provider: `custom:${first.id}`, default: first.models[0]?.id, base_url: first.address, api_mode: 'chat_completions', context_length: first.models[0]?.context,
      ...(first.keyed ? { key_env: hermesKeyVariable(first.id) } : {}) } } : {}),
    // Hermes 0.23.0 resolves a key only on its keyed `providers` map; its legacy `custom_providers` list runs keyless.
    ...(servers.some(server => server.keyed) ? { providers: Object.fromEntries(servers.filter(server => server.keyed).map(server => [server.id,
      { base_url: server.address, api_mode: 'chat_completions', key_env: hermesKeyVariable(server.id), models: server.models.map(model => model.id) }])) } : {}),
    custom_providers: servers.filter(server => !server.keyed).map(server => ({ name: server.id, base_url: server.address, api_mode: 'chat_completions',
      api_key: '', models: server.models.map(model => model.id) })),
  }, null, 2) + '\n'
}

/** One owned foreground gateway; ACP children only view its project-scoped sessions. */
export class HermesRuntime {
  private child: ChildProcess | undefined
  private stopping = false
  private starting: Promise<void> | undefined
  private closedWork = Promise.resolve()
  readonly keys: HermesKeys
  constructor(readonly root: string, private readonly lost: () => void, private readonly environment: NodeJS.ProcessEnv = process.env) {
    this.keys = new HermesKeys(join(root, 'own-server-keys.json'))
  }

  env(home = this.root, cwd = this.root): NodeJS.ProcessEnv {
    return { ...hermesEnvironment(home, {}, this.environment), PWD: cwd }
  }
  async writeConfig(home: string, servers: readonly OwnServer[], cwd?: string): Promise<void> {
    await mkdir(home, { recursive: true })
    const keys = await this.keys.read()
    for (const [name, text] of [['config.yaml', hermesConfig(servers, cwd)], ['.env', hermesEnvFile(servers, keys)]] as const) {
      const path = join(home, name)
      if (await readFile(path, 'utf8').catch(() => '') !== text) await writeFile(path, text, { mode: 0o600 })
    }
  }
  private python(executable: string, script: string, args: string[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(join(dirname(executable), 'python'), ['-c', script, ...args], { cwd: this.root, env: withHermesPath(this.env(), executable),
        timeout: 65_000, maxBuffer: 4096 }, error => error ? reject(new Error('Hermes gateway did not become ready. Reconnect Hermes to retry.')) : resolve())
    })
  }
  start(executable: string): Promise<void> {
    if (this.starting) return this.starting
    if (this.child) return Promise.resolve()
    this.stopping = false
    const child = spawn(executable, ['gateway', 'run', '--quiet', '--no-supervise', '--external-supervisor'], {
      cwd: this.root, env: withHermesPath(this.env(), executable), stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true,
    })
    this.child = child
    this.closedWork = new Promise(resolve => {
      child.once('error', () => { if (!this.stopping) this.lost() })
      child.once('close', () => { if (this.child === child) this.child = undefined; resolve(); if (!this.stopping) this.lost() })
    })
    // Readiness only: discovery never starts a second owner, unlike `gateway ensure`.
    this.starting = this.python(executable, 'import time\nfrom pathlib import Path\nfrom hermes_cli.gateway_runtime import discover_gateway_endpoint, attachable\nfrom hermes_constants import get_hermes_home\nend=time.monotonic()+55\nwhile time.monotonic()<end:\n if attachable(discover_gateway_endpoint(get_hermes_home(), timeout=1)): break\n time.sleep(.2)\nelse: raise SystemExit(1)').finally(() => { this.starting = undefined })
    return this.starting
  }
  async project(executable: string, projectPath: string, servers: readonly OwnServer[]): Promise<string> {
    const home = hermesProjectHome(this.root, projectPath)
    await this.writeConfig(home, servers, projectPath)
    await this.start(executable)
    await this.python(executable, 'from pathlib import Path\nfrom gateway.control_socket import rescan_gateway_profiles\nfrom hermes_constants import get_hermes_home\nr=rescan_gateway_profiles(get_hermes_home(), timeout=30)\nassert isinstance(r,dict)', [])
    return home
  }
  stop(): void {
    this.stopping = true
    const child = this.child
    if (!child) return
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) } catch { /* Already gone. */ }
    }
    kill('SIGTERM')
    const timer = setTimeout(() => kill('SIGKILL'), 5000); timer.unref()
    child.once('close', () => clearTimeout(timer))
  }
  async closed(): Promise<void> { await this.closedWork }
}
