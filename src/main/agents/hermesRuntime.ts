import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OwnServer } from '../../shared/ownModelServers'
import { keylessServers } from '../ownModelServers/deepseekPatch'
import { hermesEnvironment, withHermesPath } from './hermesRpc'

/** Check availability without reading the secret. Hermes's key_cmd captures it directly from Keychain. */
export function hermesRefuselessAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'refuseless', '-a', 'default'],
      { encoding: 'utf8', maxBuffer: 8192, timeout: 10_000 }, error => resolve(!error))
  })
}

export function hermesServers(servers: readonly OwnServer[], refuseless: boolean): OwnServer[] {
  return [...keylessServers(servers), ...(refuseless ? [{ id: 'own-refuseless', name: 'Refuseless', address: 'https://api.refuseless.com/v1', keyed: false,
    models: [{ id: 'glm-5.3-flash-abliterated', name: 'GLM 5.3 Flash Abliterated', context: 131072, thinking: true, images: false }] }] : [])]
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
    ...(first ? { model: { provider: `custom:${first.id}`, default: first.models[0]?.id, base_url: first.address, api_mode: 'chat_completions', context_length: first.models[0]?.context } } : {}),
    custom_providers: servers.map(server => ({ name: server.id, base_url: server.address, api_mode: 'chat_completions',
      ...(server.id === 'own-refuseless' ? { key_cmd: '/usr/bin/security find-generic-password -s refuseless -a default -w' } : { api_key: '' }), models: server.models.map(model => model.id) })),
  }, null, 2) + '\n'
}

/** One owned foreground gateway; ACP children only view its project-scoped sessions. */
export class HermesRuntime {
  private child: ChildProcess | undefined
  private stopping = false
  private starting: Promise<void> | undefined
  private closedWork = Promise.resolve()
  constructor(readonly root: string, private readonly lost: () => void, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  env(home = this.root, cwd = this.root): NodeJS.ProcessEnv {
    return { ...hermesEnvironment(home, {}, this.environment), PWD: cwd }
  }
  async writeConfig(home: string, servers: readonly OwnServer[], cwd?: string): Promise<void> {
    await mkdir(home, { recursive: true })
    const path = join(home, 'config.yaml'), text = hermesConfig(servers, cwd)
    if (await readFile(path, 'utf8').catch(() => '') !== text) await writeFile(path, text, { mode: 0o600 })
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
