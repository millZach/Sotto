// Stands in for `systemctl --user` and `loginctl` on a Linux host, for the start at boot tests (ADR-0054). Real systemd is
// never touched. The first argument names the command; the state lives in FAKE_SYSTEMD_STATE, a JSON file the test writes
// and reads, and every call is appended to FAKE_SYSTEMD_RECORD. `start` runs the unit the launch script wrote under
// XDG_CONFIG_HOME: through /bin/sh where there is one, and on Windows by reading the variables boot-start.sh sets.
//
// The state's switches: `systemd: false` is a machine that does not run systemd (WSL without it, a container), where
// loginctl fails too and `is-system-running` says offline; `userManager: false` makes every `systemctl --user` call fail
// as it does with no user manager, until `enable-linger` starts one on a machine that runs systemd; `linger` is the
// account's setting and `enableLinger: 'refuse'` has polkit refuse `loginctl enable-linger`; `startExit` is the exit code
// `start` gives and `enableExit` the one `enable` gives; `afterStart` scripts what the unit does once started: `run` (the
// default) runs the host, `failed` lands failed, `crash-loop` keeps restarting with its runs failing, `retry-once` fails once and then runs the
// host, and `lost-lock` has another host take the folder's lock while the unit's host gives up with exit code 75. With
// `once` set, `afterStart` holds for the next start alone.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const [command, ...args] = process.argv.slice(2)
const statePath = process.env.FAKE_SYSTEMD_STATE
const read = () => ({ userManager: true, linger: true, enableLinger: 'allow', enabled: false, startExit: 0, afterStart: 'run', ...JSON.parse(readFileSync(statePath, 'utf8')) })
const write = value => writeFileSync(statePath, JSON.stringify(value, null, 2))
const record = event => appendFileSync(process.env.FAKE_SYSTEMD_RECORD, JSON.stringify(event) + '\n')
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const unitPath = join(process.env.XDG_CONFIG_HOME ?? '', 'systemd', 'user', 'sotto-host.service')
const unquote = value => value.slice(1, -1).split("'\\''").join("'")

/** The script the unit runs, from its ExecStart= line, read back the way systemd reads its quoting. */
function bootScript() {
  const line = readFileSync(unitPath, 'utf8').split(/\r?\n/u).find(item => item.startsWith('ExecStart=/bin/sh "'))
  return line.slice('ExecStart=/bin/sh "'.length, -1).replace(/\\(["\\])/gu, '$1').replace(/%%/gu, '%').replace(/\$\$/gu, '$')
}
/** Starts what the unit runs, as the user manager would, marked the way the unit's Environment= line marks it. */
function runUnit(mark = 'boot') {
  const script = bootScript()
  const env = { ...process.env, ...(mark ? { SOTTO_HOST_STARTED_BY: mark } : {}) }
  if (!mark) delete env.SOTTO_HOST_STARTED_BY
  let child
  if (process.platform === 'win32') {
    const values = Object.fromEntries(readFileSync(script, 'utf8').split(/\r?\n/u).flatMap(line => { const match = /^(node|install|data|port)=('.*')$/u.exec(line); return match ? [[match[1], unquote(match[2])]] : [] }))
    let entry = join(values.install, 'host', 'index.js')
    try { const version = readFileSync(join(values.install, 'current'), 'utf8').trim(); if (/^\d+\.\d+\.\d+$/u.test(version) && existsSync(join(values.install, 'versions', version, 'host', 'index.js'))) entry = join(values.install, 'versions', version, 'host', 'index.js') } catch { /* a flat install */ }
    child = spawn(values.node, [entry, '--data', values.data, '--port', values.port], { detached: true, stdio: 'ignore', windowsHide: true, env })
  } else child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', env })
  child.unref()
  record({ spawned: child.pid, mark: mark ?? null })
  return child.pid
}
async function stopUnit(state) {
  if (state.mainPid && alive(state.mainPid)) {
    try { process.kill(state.mainPid, 'SIGTERM') } catch { /* already gone */ }
    for (let tries = 0; tries < 200 && alive(state.mainPid); tries++) await delay(50)
  }
  Object.assign(state, { mainPid: 0, unit: { ActiveState: 'inactive', SubState: 'dead', Result: 'success', NRestarts: '0', ExecMainStatus: '0' } })
}
/** What `show` reports: a unit running a host is active while that host lives, and inactive once it has gone. */
function properties(state) {
  if (state.pendingRetry) {
    delete state.pendingRetry
    state.mainPid = runUnit()
    return { ActiveState: 'activating', SubState: 'auto-restart', Result: 'exit-code', NRestarts: '1', ExecMainStatus: '1' }
  }
  if (state.mainPid && alive(state.mainPid)) return { ActiveState: 'active', SubState: 'running', Result: 'success', NRestarts: state.unit?.NRestarts ?? '0', ExecMainStatus: '0' }
  if (state.mainPid) { state.mainPid = 0; state.unit = { ActiveState: 'inactive', SubState: 'dead', Result: 'success', NRestarts: '0', ExecMainStatus: '0' } }
  return state.unit ?? { ActiveState: 'inactive', SubState: 'dead', Result: 'success', NRestarts: '0', ExecMainStatus: '0' }
}

async function systemctl(state, words) {
  if (words[0] === 'is-system-running') { process.stdout.write((state.systemd === false ? 'offline' : 'running') + '\n'); return state.systemd === false ? 1 : 0 }
  if (words[0] !== '--user') return 1
  if (!state.userManager) { process.stderr.write('Failed to connect to bus: No medium found\n'); return 1 }
  const [verb, ...rest] = words.slice(1)
  const loaded = existsSync(unitPath)
  if (verb === 'show') {
    const shown = { LoadState: loaded ? 'loaded' : 'not-found', UnitFileState: loaded ? (state.enabled ? 'enabled' : 'disabled') : '', ...properties(state) }
    shown.MainPID = String(state.mainPid && alive(state.mainPid) ? state.mainPid : 0)
    const wanted = (rest[rest.indexOf('-p') + 1] ?? '').split(',')
    process.stdout.write(wanted.map(name => `${name}=${shown[name] ?? ''}`).join('\n') + '\n')
    return 0
  }
  if (verb === 'is-active') { const active = properties(state).ActiveState; process.stdout.write(active + '\n'); return active === 'active' ? 0 : 3 }
  if (verb === 'is-enabled') { process.stdout.write((loaded ? (state.enabled ? 'enabled' : 'disabled') : 'not-found') + '\n'); return loaded && state.enabled ? 0 : 1 }
  if (verb === 'daemon-reload') return 0
  if (verb === 'enable') { if (!loaded || state.enableExit) return state.enableExit || 1; state.enabled = true; return 0 }
  if (verb === 'disable') { state.enabled = false; if (rest.includes('--now')) await stopUnit(state); return 0 }
  if (verb === 'stop') { await stopUnit(state); return 0 }
  if (verb === 'reset-failed') {
    const current = properties(state)
    if (current.ActiveState === 'failed') state.unit = { ActiveState: 'inactive', SubState: 'dead', Result: 'success', NRestarts: '0', ExecMainStatus: current.ExecMainStatus }
    return 0
  }
  if (verb === 'start') {
    if (!loaded) { process.stderr.write('Unit sotto-host.service not found.\n'); return 5 }
    if (state.startExit) { process.stderr.write('Job for sotto-host.service failed.\n'); return state.startExit }
    if (state.unit?.ActiveState === 'failed' && state.unit.Result === 'start-limit-hit') { process.stderr.write('Start request repeated too quickly.\n'); return 1 }
    if (state.mainPid && alive(state.mainPid)) return 0
    const after = state.afterStart
    // `once`: the script holds for this start alone, and the unit runs the host from the next one on.
    if (state.once) { state.afterStart = 'run'; delete state.once }
    if (after === 'failed') state.unit = { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', NRestarts: '0', ExecMainStatus: '1' }
    else if (after === 'crash-loop') state.unit = { ActiveState: 'activating', SubState: 'auto-restart', Result: 'exit-code', NRestarts: '2', ExecMainStatus: '1' }
    else if (after === 'retry-once') state.pendingRetry = true
    else if (after === 'lost-lock') {
      // Another client's host takes the lock first; the unit's host finds it held and stops with its own code.
      const other = runUnit(null)
      const lock = join(state.data, 'host-listener.lock')
      let held = false
      for (let tries = 0; tries < 200; tries++) {
        // Exit 75 means a parsed lease names a live holder. An exclusively created file
        // can still be empty while its host writes it; that is not this unit outcome yet.
        try { if (JSON.parse(readFileSync(lock, 'utf8')).pid === other && alive(other)) { held = true; break } }
        catch { /* the replacement has not published its lease yet */ }
        if (!alive(other)) throw new Error('The competing fake host exited before publishing its lease.')
        await delay(25)
      }
      if (!held) throw new Error('The competing fake host did not publish a live lease.')
      record({ otherHost: other })
      state.unit = { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', NRestarts: '0', ExecMainStatus: '75' }
    } else { state.mainPid = runUnit(); state.unit = { ActiveState: 'active', SubState: 'running', Result: 'success', NRestarts: '0', ExecMainStatus: '0' } }
    return 0
  }
  return 1
}
function loginctl(state, words) {
  if (state.systemd === false) { process.stderr.write('System has not been booted with systemd as init system (PID 1).\n'); return 1 }
  const list = words.filter(word => word !== '--no-ask-password')
  if (list[0] === 'show-user') { process.stdout.write(`Linger=${state.linger ? 'yes' : 'no'}\n`); return 0 }
  if (list[0] === 'enable-linger') {
    if (state.enableLinger === 'refuse') { process.stderr.write('Could not enable linger: Access denied\n'); return 1 }
    // Linger starts the account's user manager, as logind does for an account with no session.
    state.linger = true; state.userManager = true; return 0
  }
  return 1
}

const state = read()
record({ command, args })
const code = command === 'systemctl' ? await systemctl(state, args) : command === 'loginctl' ? loginctl(state, args) : 127
write(state)
process.exitCode = code
