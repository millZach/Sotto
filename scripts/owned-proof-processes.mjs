// Each run owns a systemd slice. Per-command scopes contain descendants across setsid/reparenting.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as wait } from 'node:timers/promises'
import { setTimeout, clearTimeout } from 'node:timers'

const run = promisify(execFile)
export const proofSystemdEnvironment = () => {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`
  return { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus` }
}
const identity = pid => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { pid: Number(pid), state: fields[0], start: fields[19] }
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error }
}
export const isProofProcessAlive = pid => {
  const current = identity(pid)
  return Boolean(current && current.state !== 'Z' && current.state !== 'X')
}

export async function terminateThenCleanup(terminate, tasks) {
  const errors = []
  try { await terminate() } catch (error) { errors.push(error) }
  for (const task of tasks) {
    try { await task() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Proof cleanup failed after process termination')
}

export function installProofCleanup(performCleanup, report, timeoutMs = 12000) {
  let pending, interrupted
  const onInt = () => onSignal('SIGINT', 130)
  const onTerm = () => onSignal('SIGTERM', 143)
  const cleanup = () => {
    if (pending) return pending
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Proof cleanup deadline')), timeoutMs)
    })
    pending = Promise.race([Promise.resolve().then(performCleanup), deadline]).finally(() => {
      clearTimeout(timer)
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
    })
    return pending
  }
  const onSignal = (signal, code) => {
    if (interrupted) return
    interrupted = signal
    process.exitCode = code
    report(`Interrupted by ${signal}; cleaning up`)
    // The main body may be waiting on a debugger. Exit only after the shared cleanup.
    void cleanup().then(() => process.exit(code), error => { console.error(error); process.exit(code) })
  }
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  return {
    cleanup,
    assertRunning() { assert.ok(!interrupted && !pending, 'The proof has been interrupted or is cleaning up') },
  }
}

export function createOwnedProofProcesses(report) {
  const token = randomUUID().replaceAll('-', '')
  const slice = `app-sottoproof${token}.slice`
  const commands = []
  const recorded = new Map()
  const cgroups = new Set()
  const systemdEnv = proofSystemdEnvironment()
  let stopping
  const remember = pid => {
    const current = identity(pid)
    if (current) recorded.set(`${pid}:${current.start}`, current)
  }
  const members = () => {
    const found = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue
      let path
      try { path = readFileSync(`/proc/${name}/cgroup`, 'utf8').trim().split('::')[1] }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error }
      if (!path?.includes(`/${slice}/`)) continue
      const root = path.slice(0, path.indexOf(`/${slice}/`) + slice.length + 1)
      cgroups.add(join('/sys/fs/cgroup', root))
      remember(Number(name))
      if (isProofProcessAlive(Number(name))) found.push(Number(name))
    }
    return found.sort((a, b) => a - b)
  }
  const start = (name, executable, args, options = {}) => {
    assert.ok(!stopping, 'Cannot start a process during proof cleanup')
    const scope = `sotto-proof-${token}-${commands.length}.scope`
    // --scope execs the command in the runner's PID after placing it in its cgroup.
    const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no',
      `--unit=${scope}`, `--slice=${slice}`, '--property=KillMode=control-group', '--property=TimeoutStopSec=2s',
      '--', executable, ...args], { ...options, env: { ...systemdEnv, ...options.env }, detached: true })
    child.proofScope = scope
    child.once('error', error => { child.proofError = error })
    if (child.pid) { commands.push({ name, pid: child.pid, scope }); remember(child.pid) }
    report(`Started ${name} PID ${child.pid} in ${scope}`)
    return child
  }
  const stop = () => {
    if (stopping) return stopping
    stopping = (async () => {
      const errors = []
      // Discovery can fail, but termination of every command and scope still runs.
      try { members() } catch (error) { errors.push(error) }
      const signalGroups = signal => {
        for (const command of [...commands].reverse()) {
          try { process.kill(-command.pid, signal) } catch (error) { if (error.code !== 'ESRCH') errors.push(error) }
        }
      }
      signalGroups('SIGTERM')
      try {
        await run('systemctl', ['--user', 'stop', ...commands.map(command => command.scope), slice], { env: systemdEnv, timeout: 5000 })
      } catch (error) {
        // Collected scopes and a slice that never started may already be unloaded.
        const lines = String(error.stderr ?? '').trim().split('\n').filter(Boolean)
        if (!lines.length || lines.some(line => !/Unit .* not loaded\./u.test(line))) errors.push(error)
      } finally { signalGroups('SIGKILL') }
      for (let i = 0; i < 30 && [...recorded.values()].some(record => {
        const current = identity(record.pid)
        return current?.start === record.start && isProofProcessAlive(record.pid)
      }); i++) await wait(50)
      const remainingPids = [...recorded.values()].filter(record => {
        const current = identity(record.pid)
        return current?.start === record.start && isProofProcessAlive(record.pid)
      }).map(record => record.pid)
      const remainingMembers = members()
      const cgroupPids = directory => {
        if (!existsSync(directory)) return []
        const pids = readFileSync(join(directory, 'cgroup.procs'), 'utf8').trim().split('\n').filter(Boolean).map(Number)
        for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) pids.push(...cgroupPids(join(directory, entry.name)))
        return pids
      }
      const remainingCgroup = [...cgroups].flatMap(cgroupPids)
      for (const directory of cgroups) if (existsSync(directory)) assert.match(readFileSync(join(directory, 'cgroup.events'), 'utf8'), /^populated 0$/mu)
      for (const command of commands) report(`Stopped ${command.name} PID ${command.pid}`)
      report(`Stopped proof slice ${slice}`)
      report(`Recorded PIDs still running: ${JSON.stringify(remainingPids)}`)
      report(`Proof cgroup processes after cleanup: ${JSON.stringify(remainingCgroup)}`)
      report(`Owned processes still running: ${JSON.stringify(remainingMembers)}`)
      assert.deepEqual(remainingPids, [], 'Every recorded proof PID must stop')
      assert.deepEqual(remainingCgroup, [], 'The proof cgroup must be empty')
      assert.deepEqual(remainingMembers, [], 'No process may remain in the proof slice')
      const state = await run('systemctl', ['--user', 'show', slice, '--property=ActiveState', '--value'], { env: systemdEnv, timeout: 2000 })
      assert.ok(['inactive', 'failed'].includes(state.stdout.trim()), 'The proof slice must have stopped')
      if (errors.length) throw new AggregateError(errors, 'Proof termination completed with discovery or systemd errors')
    })()
    return stopping
  }
  const owns = (pid, child) => {
    try {
      const path = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('::')[1]
      return Boolean(path?.endsWith(`/${slice}/${child.proofScope}`) || path?.includes(`/${slice}/${child.proofScope}/`))
    } catch { return false }
  }
  return { start, stop, owns, slice }
}
